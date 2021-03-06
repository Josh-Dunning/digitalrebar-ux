/*
  Copyright 2017, RackN
  Rebar UX API Core
*/
(function () {

  // capitalize function
  function capitalize(txt) {
    return txt.charAt(0).toUpperCase() +
      txt.substr(1).toLowerCase();
  }

  // converts under_score to CamelCase
  function camelCase(name) {
    return name.split('_').map(capitalize).join('');
  }

  let app = angular.module('app');

  app.filter('from', function () {
    return function (items, type, obj) {
      // _node | from:'deployment':deployment
      // gets all nodes with deployment_id == deployment.id
      let id = obj && obj.id || 0;
      let result = [];
      angular.forEach(items, function (value) {
        if (value[type + '_id'] === id)
          result.push(value);
      });
      return result;
    };
  });

  app.run(['$rootScope', '$cookies', 'api',
    function ($rootScope, $cookies, api) {
      // use regex to get the current location
      let currentLocation = 'https://' + location.hostname;
      $rootScope.host = $cookies.get('host') || currentLocation;

      $rootScope.$on('updateApi', function () {
        api.reloading = true;
        api.getHealth();
        api.getUsers();

        // make the api calls and add callbacks
        function finishReloading () {
          api.reloading = false;
        }

        // loops through 'fetch', calling api.getDeployments
        //      and emitting the proper callback (deploymentsDone)
        app.types.forEach(function (name) {
          api.queue.push(function(){
            api['get' + camelCase(name)]().then(function () {
              // we finished this guy :)
              $rootScope.$broadcast(name + 'Done');

              // nothing left to get, we're done!
              if(api.queue.length === 0)
                finishReloading();

              api.nextQueue();
            }, function(){
              if(api.queue.length === 0)

                finishReloading();
              api.nextQueue();
            });
          });
        });
      });

      $rootScope.$on('startUpdating', function () {
        api.reload();
        api.getActive();
      });

      $rootScope.tryFetch = function () {
        $rootScope.$emit('updateApi');
      };

      $rootScope._pollTimer;
      $rootScope._pollRate = 15;
      $rootScope._pollRateOverride = false;
      $rootScope._deployments = {};
      $rootScope._deployment_roles = {};
      $rootScope._roles = {};
      $rootScope._nodes = {};
      $rootScope._profiles = {};
      $rootScope._networks = {};
      $rootScope._network_ranges = {};
      $rootScope._node_roles = {};
      $rootScope._providers = {};
      $rootScope._barclamps = {};
      $rootScope.wizardBarclamps = [];

      $rootScope.showDNS = false;
      $rootScope._DNS = { zones: [] };

      $rootScope.showDHCP = false;
      $rootScope._DHCP = { subnets: [] };

      $rootScope.showProvisioner = false;
      $rootScope._provisioner = { bootenvs: [], templates: [], machines: [] };

      $rootScope._engine = {};
      $rootScope._users = {};
      $rootScope._tenants = {};
      $rootScope._capabilities = {};
    }
  ]);

  app.factory('api', [
    '$http', '$rootScope', '$timeout', '$mdToast', 'debounce',
    'localStorageService',
    function ($http, $rootScope, $timeout, $mdToast, debounce,
      localStorageService) {

      // function for calling api functions ( eg. /api/v2/nodes )
      // to use:
      // api('/path/to/api', {data: {asdf}, method: 'GET'})
      // .then(function(data){}, function(data){})
      let api = function (path, args) {
        args = args || {};
        args.method = args.method || 'GET';
        args.headers = args.headers || {};
        args.api = true;
        args.url = $rootScope.host + path;
        return $http(args);
      };
      api.reloading = false;

      app.types = ['deployments', 'roles', 'nodes', 'profiles', 'node_roles',
        'deployment_roles', 'networks', 'network_ranges', 'providers',
        'barclamps'
      ];

      api.testSchema = function (data, schema) {
        if (typeof schema === 'undefined')
          return true;
        if (typeof data === 'undefined' && !schema.required)
          return true;

        switch (schema.type) {
        case 'any': // data is anything
          return true;

        case 'str': // data is a string
          if  (typeof data !== 'string')
            return false;

          if (!schema.pattern)
            return true;

          let regex = new RegExp(
            schema.pattern.substr(1, schema.pattern.length - 2));
          return !!data.match(regex);

        case 'bool': // data is a boolean
          return typeof data === 'boolean';

        case 'int': // data is a number
          return typeof data === 'number';

        case 'seq': // data is an array
          if (typeof data !== 'object' || !Array.isArray(data))
            return false;

          let newSchema = schema.sequence[0];
          // test all items in data against the schema's sequence
          for (let i in data) {
            if (!api.testSchema(data[i], newSchema))
              return false;
          }

          return true;
        case 'map': // data is a hash table
          if (typeof data !== 'object' || Array.isArray(data))
            return false;

          // handle cases where '=' is the only thing passed in mapping
          if(typeof schema.mapping['='] !== 'undefined') {
            let newSchema = schema.mapping['='];
            for (let key in data) {
              if (!api.testSchema(data[key], newSchema))
                return false;
            }
          } else {
            // check if data's children are valid
            for (let key in schema.mapping) {
              let newSchema = schema.mapping[key];
              if (!api.testSchema(data[key], newSchema))
                return false;
            }

            // check if data has extra keys
            for (let key in data) {
              if (typeof schema.mapping[key] === 'undefined')
                return false;
            }

          }


          return true;
        }
        return false;
      };

      api.exampleFromSchema = function (schema) {
        if (typeof schema === 'undefined')
          return '';
        switch (schema.type) {
        case 'any':
          return '=' + (schema.required ? '*' : '');

        case 'str':
          return 'string' + (schema.required ? '*' : '') +
            (schema.pattern ? ' ' + schema.pattern : '');

        case 'bool':
          return 'boolean' + (schema.required ? '*' : '');

        case 'int':
          return 'number' + (schema.required ? '*' : '');

        case 'seq':
          let newSchema = schema.sequence[0];
          newSchema.required = schema.required;
          return [api.exampleFromSchema(newSchema)];

        case 'map':
          let map = {};
          for (let key in schema.mapping) {
            let newSchema = schema.mapping[key];
            map[key] = api.exampleFromSchema(newSchema);
          }
          return map;
        }
      };


      api.lastUpdate = new Date().getTime();

      api.queue = [];
      api.queueLen = 0;

      api.errors = localStorageService.get('errors') || [];

      api.toast = function (message, error, err) {
        $mdToast.show(
          $mdToast.simple()
          .textContent(message)
          .position('bottom left')
          .hideDelay(3000)
        );
        if (error) {
          api.errors.push({
            type: error,
            message: message,
            err: err,
            stack: new Error().stack,
            date: Date.now()
          });
          localStorageService.add('errors', api.errors);
        }
      };

      api.get_id = function(url) {
        let headers = { 'headers': {'x-return-attributes':'["id"]'}};
        return api(url, headers);
      };

      api.fetch = function (name, id) {
        let headers = {};
        if (name === 'node_role')
          headers = {
            'headers': {
              'x-return-attributes':'["id","name","deployment_id",' +
              '"role_id","node_id","state","cohort","run_count","status",' +
              '"available","order","created_at","updated_at","uuid",' +
              '"tenant_id","node_error"]'
            }
          };
        return api('/api/v2/' + name + 's/' + id, headers)
        .then(function (resp) {
          api['add' + camelCase(name)](resp.data);
        }, function (err) {
          if(err.data === 'Unauthorized\n') {
            $rootScope.$broadcast(name + id + 'Done');
            return;
          }
          api.remove(name, id);
          $rootScope.$broadcast(name + id + 'Done');
        });
      };

      api.reload = function () {
        $rootScope.$emit('updateApi');
        api.lastUpdate = new Date().getTime();
        debounce(api.reload, 3 * 60 * 1000, false)();
      };


      // add an api call to the queue
      api.addQueue = function (name, id) {
        api.queue.push(function () {
          api.fetch(name, id)
          .then(api.nextQueue, api.nextQueue);

        });
      };

      api.nextQueue = function () {
        // if the queue isn't empty
        if (api.queue.length) {
          // eval and remove the first one
          $rootScope.$evalAsync(
            api.queue.splice(0, 1)[0]
          );
        } else { // queue is empty, wait and populate it
          api.queueLen = 0;
          $rootScope._pollTimer = $timeout(
            api.getActive, $rootScope._pollRate * 1000);
        }
      };

      api.pollRate = function(rate, override) {
        if (override && !$rootScope._pollRateOverride)
          $rootScope._pollRateOverride = true;
        if ($rootScope._pollRate !== rate) {
          $timeout.cancel($rootScope._pollTimer);
          $rootScope._pollRate = rate;
          console.debug('Polling Rate set to ' + $rootScope._pollRate +
            ' (override ' + $rootScope._pollRateOverride + ')');
        }
      };

      api.getActive = function () {
        // time since last update in seconds
        let deltaTime = Math.ceil(
          (new Date().getTime() - api.lastUpdate) / 1000);

        api('/api/status/active', {
          method: 'PUT',
          params: {
            age: deltaTime
          },
          data: { // sending only the IDs of nodes and deployments
            nodes: Object.keys($rootScope._nodes).map(Number),
            deployments: Object.keys($rootScope._deployments).map(Number)
          }
        }).then(function (resp) {
          let data = resp.data;
          api.lastUpdate = new Date().getTime();
          for (let type in data.changed) {
            // using forEach for asynchronous api calls
            data.changed[type].forEach(function (id) {
              // remove the plural from the type (nodes -> node)
              let name = /^.*(?=s)/.exec(type)[0];
              api.addQueue(name, id);
            });
          }

          for (let type in data.deleted) {
            for (let i in data.deleted[type]) {
              let id = data.deleted[type][i];
              let name = /^.*(?=s)/.exec(type)[0];
              try {
                api.remove(name, id);
              } catch (e) {
                console.warn(e);
              }
            }
          }

          api.queueLen = api.queue.length;
          // start the queue
          api.nextQueue();
        }, function (resp) {
          console.warn(resp);
          api.nextQueue();
        });
      };

      api.getHealth = function () {
        api('/health').then(function (resp) {
          let map = resp.data.Map;
          $rootScope.showDNS = typeof map['dns-mgmt-service'] !== 'undefined';
          $rootScope.showDHCP = typeof map['dhcp-mgmt-service'] !== 'undefined';
          $rootScope.showProvisioner = typeof map['provisioner-mgmt-service']
            !== 'undefined';
          $rootScope.showEngine = typeof map['rule-engine-service']
            !== 'undefined';

          if ($rootScope.showEngine) {
            api('/rule-engine/api/v0/rulesets/').then(function (resp) {
              $rootScope._engine = resp.data;
            });
          }

          if ($rootScope.showDNS) {
            api('/dns/zones').then(function (resp) {
              $rootScope._DNS.zones = resp.data;
            });
          }

          if ($rootScope.showDHCP) {
            api('/dhcp/subnets').then(function (resp) {
              $rootScope._DHCP.subnets = resp.data;
            });
          }

          if ($rootScope.showProvisioner) {
            api('/provisioner/machines').then(function (resp) {
              $rootScope._provisioner.machines = resp.data;
            });
            api('/provisioner/templates').then(function (resp) {
              $rootScope._provisioner.templates = resp.data;
            });
            api('/provisioner/bootenvs').then(function (resp) {
              $rootScope._provisioner.bootenvs = resp.data;
            });
          }

        }, function () {
          $rootScope.showDNS = false;
          $rootScope.showDHCP = false;
          $rootScope.showProvisioner = false;
        });
      };

      function inOrderMap(map, arr, depth) {
        if (typeof depth === 'undefined')
          depth = 0;
        for (let i in map) {
          arr.push(map[i]);
          map[i].depth = depth;
          inOrderMap(map[i].children, arr, depth + 1);
        }
      }

      api.getUsers = function () {
        api('/api/v2/users')
        .then(function (resp) {
          let users = resp.data;
          $rootScope._users = {};
          for (let i in users) {
            users[i].caps = {};
            $rootScope._users[users[i].id] = users[i];
          }

          // get capabilities for all users after getting users
          api('/api/v2/user_tenant_capabilities')
          .then(function (resp) {
            let caps = resp.data;
            for (let i in caps) {
              let cap = caps[i];
              if (!$rootScope._users[cap.user_id].caps[cap.tenant_id]) {
                $rootScope._users[cap.user_id].caps[cap.tenant_id] = {
                  id: cap.tenant_id,
                  caps: []
                };
              }
              $rootScope._users[cap.user_id]
                .caps[cap.tenant_id]
                .caps.push(cap.capability_id);
            }

          });

          // get a list of tenants
          api('/api/v2/tenants')
          .then(function (resp) {
            let arr = resp.data;
            $rootScope._tenants = {};
            for (let i in arr) {
              arr[i].children = [];
              arr[i].users = [];
              $rootScope._tenants[arr[i].id] = arr[i];

              // initialize empty caps where necessary
              for (let j in users) {
                if(typeof users[j].caps[arr[i].id] === 'undefined')
                  users[j].caps[arr[i].id] = {
                    id: arr[i].id,
                    caps: []
                  };
              }
            }

            // move applicable users into their respected tenants
            for (let i in users) {
              $rootScope._tenants[users[i].tenant_id].users.push(users[i]);
            }

            // get the parents of each tenant and put tenants into map form
            let parents = [];
            for (let i in $rootScope._tenants) {
              let tenant = $rootScope._tenants[i];
              if (typeof tenant.parent_id === 'undefined' ||
                  !$rootScope._tenants[tenant.parent_id])
                parents.push(tenant);
              else {
                $rootScope._tenants[tenant.parent_id].children.push(tenant);
              }
            }

            // make an array with tenants traversed inOrder
            $rootScope._tenantsInOrder = [];
            inOrderMap(parents, $rootScope._tenantsInOrder);

          });
        });


        // get a list of capabilities
        api('/api/v2/capabilities')
        .then(function (resp) {
          let arr = resp.data;
          $rootScope._capabilities = {};
          for (let i in arr)
            $rootScope._capabilities[arr[i].id] = arr[i];
        });
      };

      api.remove = function (type, parentId) {
        if (typeof parentId === 'undefined')
          return;

        if (!$rootScope['_' + type + 's'][parentId])
          return;

        console.log('removing ' + type + ' ' + parentId);

        delete $rootScope['_' + type + 's'][parentId];
        $rootScope.$broadcast(type + parentId + 'Done');

        if (type === 'deployment') {
          ['nodes', 'node_roles'].forEach(function (item) {
            let name = /^.*(?=s)/.exec(item)[0];
            for (let id in $rootScope['_' + item]) {
              let child = $rootScope['_' + item][id];
              if (child.deployment_id === parentId)
                api.addQueue(name, id);
            }
          });
        }

      };


      api.addDeployment = function (deployment) {
        let id = deployment.id;
        $rootScope._deployments[id] = deployment;
        $rootScope.$broadcast('deployment' + id + 'Done');
      };

      api.getDeployments = function () {
        return api('/api/v2/deployments')
        .then(function (resp) {
          $rootScope._deployments = {};
          resp.data.map(api.addDeployment);
        });
      };

      api.addNode = function (node) {
        let id = node.id;

        node.address = node['node-control-address'];

        let state = $rootScope.states[node.state];
        if (!node.alive) {
          state = 'off';
          if (node.reserved)
            state = 'reserved';
        }
        node.status = state;

        // assign simple states for the dashboard pie chart
        if (!node.alive)
          node.simpleState = 3; //off
        else {
          node.simpleState = 2; // todo
          if (node.state === -1)
            node.simpleState = 1; // error
          if (node.state === 0)
            node.simpleState = 0; // ready
        }

        $rootScope._nodes[id] = node;
        $rootScope.$broadcast('node' + id + 'Done');
        // slow down polling for large systems
        if (!$rootScope._pollRateOverride) {
          if (Object.keys($rootScope._nodes).length > 25)
            api.pollRate(45, false);
          else if (Object.keys($rootScope._nodes).length > 50)
            api.pollRate(30, false);
        }
      };

      // api call for getting all the nodes
      api.getNodes = function () {
        return api('/api/v2/nodes')
        .then(function (resp) {
          $rootScope._nodes = {};
          resp.data.map(api.addNode);
        });
      };

      api.addProfile = function (profile) {
        let id = profile.id;
        $rootScope._profiles[id] = profile;
        $rootScope.$broadcast('profile' + id + 'Done');
      };

      // api call for getting all the nodes
      api.getProfiles = function () {
        return api('/api/v2/profiles')
        .then(function (resp) {
          $rootScope._profiles = {};
          resp.data.map(api.addProfile);
        });
      };

      api.addRole = function (role) {
        let id = role.id;
        $rootScope._roles[id] = role;
        $rootScope.$broadcast('role' + id + 'Done');
      };

      // api call for getting all the roles
      api.getRoles = function () {
        return api('/api/v2/roles')
        .then(function (resp) {
          $rootScope._roles = {};
          resp.data.map(api.addRole);
        });
      };

      api.addDeploymentRole = function (role) {
        // allow deployment roles to be sorted by cohort
        role.cohort = function () {
          return $rootScope._roles[role.role_id].cohort;
        };
        let id = role.id;
        $rootScope._deployment_roles[id] = role;
        $rootScope.$broadcast('deployment_role' + id + 'Done');
      };

      // api call for getting all the deployment roles
      api.getDeploymentRoles = function () {
        return api('/api/v2/deployment_roles')
        .then(function (resp) {
          $rootScope._deployment_roles = {};
          resp.data.map(api.addDeploymentRole);
        });
      };

      api.addProvider = function (provider) {
        let id = provider.id;
        $rootScope._providers[id] = provider;
        $rootScope.$broadcast('provider' + id + 'Done');
      };

      // api call for getting all the providers
      api.getProviders = function () {
        return api('/api/v2/providers')
        .then(function (resp) {
          $rootScope._providers = {};
          resp.data.map(api.addProvider);
        });
      };

      api.addNetwork = function (network) {
        let id = network.id;
        $rootScope._networks[id] = network;
        $rootScope.$broadcast('network' + id + 'Done');
      };

      api.addRange = function (range) {
        let id = range.id;
        $rootScope._network_ranges[id] = range;
        $rootScope.$broadcast('network_range' + id + 'Done');
      };

      // api call for getting all the network ranges
      api.getNetworkRanges = function () {
        return api('/api/v2/network_ranges')
        .then(function (resp) {
          $rootScope._network_ranges = {};
          resp.data.map(api.addRange);
        });
      };

      // api call for getting all the networks
      api.getNetworks = function () {
        return api('/api/v2/networks')
        .then(function (resp) {
          $rootScope._networks = {};
          resp.data.map(api.addNetwork);
        });
      };

      api.addNodeRole = function (role) {
        let id = role.id;
        role.status = $rootScope.states[role.state];
        // should be missing, but just in case we
        //  keep from storing the bulky part of the object
        delete role['runlog'];
        delete $rootScope._node_roles[id];
        $rootScope._node_roles[id] = role;
        $rootScope.$broadcast('node_role' + id + 'Done');
      };

      // api call for getting all the node roles
      api.getNodeRoles = function () {
        // headers does NOT include runlog to improve performance
        return api('/api/v2/node_roles', {
          'headers': {
            'x-return-attributes': '["id","name","deployment_id","role_id",' +
              '"node_id","state","cohort","run_count","status","available",' +
              '"order","created_at","updated_at","uuid","tenant_id",' +
              '"node_error"]'
          }
        })
        .then(function (resp) {
          $rootScope._node_roles = {};
          resp.data.map(api.addNodeRole);
        });
      };

      api.addBarclamp = function (barclamp) {
        let id = barclamp.id;
        $rootScope._barclamps[id] = barclamp;
        $rootScope.$broadcast('barclamp' + id + 'Done');

        if (barclamp.cfg_data &&
            typeof barclamp.cfg_data.wizard !== 'undefined') {

          if (!barclamp.cfg_data.wizard) return;
          if (!barclamp.cfg_data.wizard.version) return;
          if (barclamp.cfg_data.wizard.version !== 2) return;

          let exists = false;
          for (let i in $rootScope.wizardBarclamps) {
            let b = $rootScope.wizardBarclamps[i];
            if (b.id === id) {
              exists = true;
              break;
            }
          }
          if (!exists) {
            $rootScope.wizardBarclamps.push({
              id: id,
              title: barclamp.cfg_data.wizard.name,
              icon: barclamp.cfg_data.wizard.icon || 'create_new_folder',
              path: '/workloads/' + id
            });
          }
        }
      };

      // api call for getting all the barclamps
      api.getBarclamps = function () {
        return api('/api/v2/barclamps')
        .then(function (resp) {
          $rootScope._barclamps = {};
          resp.data.map(api.addBarclamp);
        });
      };

      api.saveBarclamp = function (config) {
        config.barclamp['source_path'] = 'API_uploaded';
        let payload = { 'value': config };
        api('/api/v2/barclamps', {
          method: 'POST',
          data: payload
        }).then(function () {
          api('/api/v2/barclamps/' + config.barclamp.name)
          .then(function(resp) {
            api.addBarclamp(resp.data);
          });
          api.toast('Updated barclamp');
          api.getRoles();
        }, function (err) {
          api.toast('Error Updating barclamp', 'barclamp', err.data);
        });
      };

      api.getNodeStatus = function(node) {
        let now = Date.now();
        if(typeof node === 'undefined')
          return 'error';

        // throttle the node status
        if(node._statusTime && node._statusTime + 500 > now)
          return node._status;

        node._statusTime = now;
        if (node.alive) {
          if (node.available) {
            return node._status = $rootScope.states[node.state];
          } else {
            return node._status = 'reserved';
          }
        } else {
          return node._status = 'off';
        }
      };

      api.getNodeIcon = function(node) {
        let ns = api.getNodeStatus(node);
        if (ns === 'ready')
          return node.icon;
        else
          return $rootScope.icons[ns];
      };

      api.truncName = function(name) {
        if(typeof name === 'undefined')
          return '';
        return name.substring(0, name.indexOf('.'));
      };

      return api;
    }
  ]);
})();
