var fs = require('fs');
var path = require('path');
var request = require('request');
var yaml = require('js-yaml');
var debug = false;

var showUsage = function() {
  console.log('node execute-perf-test.js <env> <cmd:push/pull> <size:S/L>');
  process.exit(1);
}

if (process.argv.length < 5) showUsage();

var env = process.argv[2];
var cmd = process.argv[3];
var size = process.argv[4];

function resolvePath(__path) {
  if (typeof(__path) === 'string') {
    return path.resolve(__dirname, __path);
  }
  return null;
}

function NiFiApi(conf) {
  this.cert = resolvePath(conf.certFile);
  this.getApiRoot = function() {
    return conf.secure ? conf.api.secure : conf.api.plain;
  }
  this.request = function(options, callback) {

    var o = {};
    if (typeof(options) === 'string') {
      // Only url is specified.
      o.url = this.getApiRoot() + options;
      o.method = 'GET';
    } else {
      // Initialize with the specified options.
      for (k in options) {
        o[k] = options[k];
      }
      o.url = this.getApiRoot() + options.url;
    }

    if (this.cert) o.ca = fs.readFileSync(this.cert);

    request(o, callback);
  }
}

/*
 * Environment dependent values.
 */

var envConf;
try {
  var envFile = fs.readFileSync(resolvePath('perf-test-config/env-' + env + '.yml'));
  envConf = yaml.safeLoad(envFile);
} catch (e) {
  console.log('Failed to load an env file', e);
  process.exit(1);
}

console.log('envConf', envConf);

var nifiApiP = new NiFiApi(envConf.nifiP);
var nifiApiQ = new NiFiApi(envConf.nifiQ);


var clientCertFile = resolvePath(envConf.clientCertFile);
var clientKeyFile = resolvePath(envConf.clientKeyFile);

/*
 * Define common functions.
 */

request = request.defaults({
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  },
  cert: (clientCertFile ? fs.readFileSync(clientCertFile) : null),
  key: (clientKeyFile ? fs.readFileSync(clientKeyFile) : null)
});

var getProcessorIdByName = function(nifiApi, name, callback) {
  nifiApi.request('/flow/search-results?q=' + name, (err, res, body) => {
    if (err) {
      callback(err);
      return;
    }
    if (res.statusCode == 200) {
      var results = JSON.parse(body).searchResultsDTO.processorResults;
      if (results.length == 0) {
        return callback({msg: 'No processor was found with name "' + name + '" within ' + nifiApi.getApiRoot()});
      }
      callback(null, results[0].id);
    } else {
      callback(res);
    }
  });
}

var getProcessor = function(nifiApi, uuid, callback) {
  nifiApi.request('/processors/' + uuid, (err, res, body) => {
    if (err) {
      callback(err);
      return;
    }
    if (res.statusCode == 200) {
      callback(null, JSON.parse(body));
    } else {
      callback(res);
    }
  });
}

var putProcessor = function(nifiApi, uuid, processor, callback) {
  if (debug) console.log('going to put', processor);
  nifiApi.request({
    url: '/processors/' + uuid,
    method: 'PUT',
    json: processor
  }, (err, res, body) => {
    if (err) {
      callback(err);
      return;
    }
    if(debug) console.log(res.statusCode);
    if (res.statusCode == 200) {
      callback(null);
    } else {
      callback(res);
    }
  });
}

var updateProcessorState = function(nifiApi, uuid, running, callback) {
  getProcessor(nifiApi, uuid, (err, processor) => {
    if (err) {
      callback(err);
      return;
    }
    putProcessor(nifiApi, uuid, {
      revision: processor.revision,
      component: {
        id: uuid,
        state: running ? "RUNNING" : "STOPPED"
      }
    }, (err) => {
      callback(err);
    })
  });
}

var updateProcessorConfig = function(nifiApi, uuid, updateConfig, callback) {
  getProcessor(nifiApi, uuid, (err, processor) => {
    if (err) {
      callback(err);
      return;
    }
    
    var c = processor.component;
    updateConfig(c.config);

    putProcessor(nifiApi, uuid, {
      revision: processor.revision,
      component: {
        id: c.id,
        name: c.name,
        config: c.config
      }
    }, (err) => {
      callback(err);
    })
  });
}

var getClusterSummary = function(nifiApi, callback) {
  nifiApi.request('/flow/cluster/summary', (err, res, body) => {
    if (err) {
      callback(err);
      return;
    }
    if (res.statusCode == 200) {
      console.log(body);
      callback(null, JSON.parse(body));
    } else {
      callback(res);
    }
  });
}

var getFlowStatus = function(nifiApi, callback) {
  nifiApi.request('/flow/status', (err, res, body) => {
    if (err) {
      callback(err);
      return;
    }
    if (res.statusCode == 200) {
      callback(null, JSON.parse(body));
    } else {
      callback(res);
    }
  });
}

var execBasedOnQueuedFlowFileCount = function(nifiApi, maxAllowedQueued, callback) {
  getFlowStatus(nifiApi, (err, flowStatus) => {
    if (err) {
      if(debug) console.log('Failed to get flow status from ' + nifiApi, err);
      callback.onErr(err);
      return;
    }
    var queuedFlowFiles = flowStatus.controllerStatus.flowFilesQueued;
    if (queuedFlowFiles > maxAllowedQueued) {
      callback.onExceed(queuedFlowFiles);
      return;
    } else {
      callback.onLess(queuedFlowFiles);
      return;
    }
  });
}

/*
 * Test logic.
 */
var executePushTest = function(generatorConfig, increaseLoad) {
  var cooldownSec = 10;
  var queuedFlowFilesCheckIntervalSec = 10;
  var flowFilesPerSec = Math.floor(generatorConfig.batchSize / (generatorConfig.intervalMillis / 1000));
  var expectedThroughputKb = flowFilesPerSec * generatorConfig.fileSizeKb;
  var start = new Date();
  var testDurationSec = generatorConfig.testDurationSec;
  // TODO: Checking queued flow-file count is not an ideal way to measure performance,
  //       I should use component stats which can be retrieved via REST api as:
  //       curl http://localhost:8080/nifi-api/remote-process-groups/c00eca0c-0156-1000-9d69-e30201d97753 |jq .status.aggregateSnapshot
  // Allow keeping up to average incoming flow-files per sec for 10 sec.
  // If queued flow-file count exceeds this, test will terminate.
  var expectedSecToBeTransferred = cmd == 'push' ? 10 : 30;
  var maxAllowedQueuedFlowFilesCount = Math.floor(flowFilesPerSec * expectedSecToBeTransferred) * generatorConfig.clusterSummary.connectedNodeCount;
  
  console.log('Stopping generator.', generatorConfig.processorName);
  getProcessorIdByName(nifiApiP, generatorConfig.processorName, (err, processorId) => {

    if (err) {
      console.log('Failed to find generator processor.', err);
      return;
    }
  
    var generatorId = processorId;
  
    var queuedFlowFilesCheck = function() {
  
      var terminateTest = function(callback) {
        console.log('Stopping generator.');
        updateProcessorState(nifiApiP, generatorId, false, (err) => {
          if (err) {
            console.log('Failed to stop the generator.', err);
            return;
          }
          console.log('Finished test.');
          if (callback) {
            callback();
          }
        });
      }
  
      execBasedOnQueuedFlowFileCount(nifiApiP, maxAllowedQueuedFlowFilesCount, {onErr: (err) => {
          console.log('Failed to get flow status from P.', err);
  
      }, onExceed: (countP) => {
          console.log('Too many queued flow-files (' + countP + ') in NiFi P. Terminate the test.');
          terminateTest();
  
      }, onLess: (countP) => {
  
        execBasedOnQueuedFlowFileCount(nifiApiQ, maxAllowedQueuedFlowFilesCount - countP, {onErr: (err) => {
            console.log('Failed to get flow status from Q.', err);
  
        }, onExceed: (countQ) => {
            console.log('Too many queued flow-files in NiFi P and Q (' + countP + ', ' + countQ + '). Terminate the test.');
            terminateTest();
  
        }, onLess: (countQ) => {
            // Check elapsed time.
            var now = new Date();
            var elapsedMillis = (now.getTime() - start.getTime());
            console.log(Math.floor(elapsedMillis / 1000) + ',' + countP + ',' + countQ);
    
            if (elapsedMillis > testDurationSec * 1000) {
              console.log('Congratulations! The test have survived for ' + testDurationSec + ' sec. At expected throughput (kb/sec) :' + expectedThroughputKb);

              var nextTest = function() {
                // Wait until queued files are fully drained.
                var waitUntilFullyDrained = function() {
                  execBasedOnQueuedFlowFileCount(nifiApiP, 0, {onErr: (err) => {
                      console.log('Failed to get flow status from P.', err);
    
                  }, onExceed: (countP) => {
                      console.log(countP + ' queued flow-files remaining in NiFi P. Wait for a while.');
                      setTimeout(waitUntilFullyDrained, 10000);

                  }, onLess: (countP) => {
                    console.log(countP + ' queued flow-files remaining in NiFi P. Checking Q..');

                    var waitUntilFullyDrainedQ = function() {
                      execBasedOnQueuedFlowFileCount(nifiApiQ, 0, {onErr: (err) => {
                          console.log('Failed to get flow status from Q.', err);
    
                      }, onExceed: (countQ) => {
                          console.log(countQ + ' queued flow-files remaining in NiFi Q. Wait for a while.');
                          setTimeout(waitUntilFullyDrainedQ, 10000);

                      }, onLess: (countQ) => {
                        console.log(countQ + ' queued flow-files remaining in NiFi Q. Proceeding with the next test..');
                        increaseLoad(generatorConfig);
                        executePushTest(generatorConfig, increaseLoad);
  
                      }});
                    }
                    waitUntilFullyDrainedQ();

                  }});
                }
                waitUntilFullyDrained();
              }

              terminateTest(nextTest);

            } else {
              setTimeout(queuedFlowFilesCheck, queuedFlowFilesCheckIntervalSec * 1000);
            }
        }});
  
      }});
  
    }
  
  
    updateProcessorState(nifiApiP, generatorId, false, (err) => {
      if (err) {
        console.log('Failed to stop the generator.', err);
        return;
      }
  
      execBasedOnQueuedFlowFileCount(nifiApiP, 0, {onErr: (err) => {
          console.log('Failed to get flow status from P.', err);
  
      }, onExceed: (count) => {
          console.log('There are ' + count + ' flow-files remaining in NiFi P queue. Cannot start test until it becomes empty.');
  
      }, onLess: (count) => {
  
        execBasedOnQueuedFlowFileCount(nifiApiQ, 0, {onErr: (err) => {
            console.log('Failed to get flow status from Q.', err);
    
        }, onExceed: (count) => {
            console.log('There are ' + count + ' flow-files remaining in NiFi Q queue. Cannot start test until it becomes empty.');
    
        }, onLess: (count) => {
          console.log('Updating generator config.', generatorConfig);
          console.log('maxAllowedQueuedFlowFilesCount', maxAllowedQueuedFlowFilesCount);
          updateProcessorConfig(nifiApiP, generatorId, (config) => {
            config.schedulingPeriod = generatorConfig.intervalMillis + 'ms';
            config.properties['Batch Size'] = generatorConfig.batchSize;
            config.properties['File Size'] = generatorConfig.fileSizeKb + 'kb';
      
          }, (err) => {
            if (err) {
              console.log('Failed to update the generator config.', err);
              return;
            }
      
            console.log('Waiting for ' + cooldownSec + ' sec to cooldown.');
            setTimeout(() => {
              console.log('Starting generator.');
              updateProcessorState(nifiApiP, generatorId, true, (err) => {
                if (err) {
                  console.log('Failed to start the generator.', err);
                  return;
                }
      
                console.log('Checking how many flow-files are queued in every ' + queuedFlowFilesCheckIntervalSec + ' sec..');
                queuedFlowFilesCheck();
      
              });
            }, cooldownSec * 1000);
          });
        }});  
      }});  
    });
  });
}

/*
 * Main logic.
 */

var generatorConfigs = {
  S: {
    intervalMillis: 100,
    batchSize: 100,
    fileSizeKb: 1,
    testDurationSec: 60,
    incrementBatchSize: 100,
    incrementFileSizeKb: 0
  },
  L: {
    intervalMillis: 1000,
    batchSize: 1,
    fileSizeKb: 15000,
    testDurationSec: 60,
    incrementBatchSize: 0,
    incrementFileSizeKb: 5000
  }
};

var generatorConfig = generatorConfigs[size];
if (!generatorConfig) {
  console.log('Size ' + size + ' does not exist.');
  process.exit(1);
}
generatorConfig.processorName = cmd + '-data-generator';


getClusterSummary(nifiApiP, (err, clusterSummary) => {
  if (err) {
    console.log('Failed to get clusterSummary', err);
    return;
  }
  generatorConfig.clusterSummary = clusterSummary.clusterSummary;
  executePushTest(generatorConfig, (config) => {
    // Increase load.
    config.batchSize += generatorConfig.incrementBatchSize;
    config.fileSizeKb += generatorConfig.incrementFileSizeKb;
  });
});
