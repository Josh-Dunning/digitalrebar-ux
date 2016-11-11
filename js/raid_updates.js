/*
bios settings controller
*/
(function () {
  angular.module('app').controller('RaidUpdatesCntrl', function ($mdMedia, $mdDialog, $scope, $http, debounce, $timeout, api, $filter) {
    $scope.$emit('title', 'Bios Settings'); // shows up on the top toolbar

    var raidupdates = this;

    $scope.expand = {};

    $scope.settings = {};
    $scope.loadSettings = function () {
        api("/api/v2/attribs/bios-set-mapping").
          success(function (obj) {
              $scope.settings = obj.default.value;
              console.log("GREG: obj = ", obj.default.value);
          }).
          error(function (err) {
            api.toast("Error Bios Setting Data", 'bios_setting', err);
          });
    }

    // called when a deployment is clicked
    this.toggleExpand = function (id) {
      $scope.expand[id] = !$scope.expand[id];
    };

    // creates the node role status data for all the deployments
    // takes a sum of the all the node roles and all the errors
    this.createStatusBarData = function () {
      $scope.$evalAsync(function () {
        for (var id in $scope._deployments) {
          if (!$scope.binding[id])
            $scope.binding = false;
          deployments.deploymentStatus[id] = { error: 0, total: 0 }
          for (var roleId in $scope._node_roles) {
            var node_role = $scope._node_roles[roleId];
            if (node_role.deployment_id != id)
              continue;

            var state = node_role.state;
            if (state == -1)
              deployments.deploymentStatus[id].error++;
            deployments.deploymentStatus[id].total++;
          }
        }
      });
    };

    // creates a confirmation dialog before deleting the deployment
    $scope.deleteDeployment = function (event, id) {
      $scope.confirm(event, {
        title: "Delete Deployment",
        message: "Are you sure you want to delete deployment " + $scope._deployments[id].name + "?",
        yesCallback: function () {
          api("/api/v2/deployments/" + id, { method: "DELETE" }).
          success(function () {
            api.remove("deployment", id);
          }).
          error(function (err) {
            api.toast("Error Deleting Deployment", 'deployment', err);
          })
        }
      });
    };

    $scope.createDeploymentPrompt = function (ev) {
      var confirm = $mdDialog.prompt()
        .title('Create Deployment')
        .textContent('Enter the Name of the New Deployment')
        .placeholder('Deployment Name')
        .targetEvent(ev)
        .ok('Create')
        .cancel('Cancel');
      $mdDialog.show(confirm).then(function (name) {
        api('/api/v2/deployments', {
          method: "POST",
          data: {
            name: name
          }
        }).success(api.addDeployment).
        success(function () {
          deployments.createPieChartData();
          deployments.createStatusBarData();
        }).
        error(function (err) {
          api.toast("Couldn't Create Deployment", 'deployment', err);
        });
      }, function () {});
    };

    $scope.loadSettings();
  });

})();
