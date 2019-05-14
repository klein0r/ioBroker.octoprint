/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

var utils = require('@iobroker/adapter-core');
var request = require('request');

let adapter;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {
        name: 'octoprint',
        ready: () => main()
    });

    adapter = new utils.Adapter(options);

    return adapter;
};

var conntected = false;
var printerStatus = 'Disconnected';

adapter.on('unload', function (callback) {
    try {
        setPrinterOffline();
        callback();
    } catch (e) {
        callback();
    }
});

adapter.on('stateChange', function (id, state) {
    if (state && !state.ack) {
        // No ack = changed by user
        if (conntected) {
            if (id.match(new RegExp(adapter.namespace + '\.temperature\.tool[0-9]{1}\.target'))) {
                adapter.log.debug('changing target tool temperature to ' + state.val);

                // TODO: Check which tool has been changed
                buildRequest(
                    'printer/tool',
                    function(content) {
                        refreshState();
                    },
                    {
                        command: 'target',
                        targets: {
                            tool0: state.val
                        }
                    }
                );
            } else if (id == adapter.namespace + '.temperature.bed.target') {
                adapter.log.debug('changing target bed temperature to ' + state.val);

                buildRequest(
                    'printer/bed',
                    function(content) {
                        refreshState();
                    },
                    {
                        command: 'target',
                        target: state.val
                    }
                );
            } else if (id == adapter.namespace + '.command.printer') {

                var allowedCommandsConnection = ['connect', 'disconnect', 'fake_ack'];
                var allowedCommandsPrinter = ['home'];

                if (allowedCommandsConnection.indexOf(state.val) > -1) {
                    adapter.log.debug('sending printer connection command: ' + state.val);

                    buildRequest(
                        'connection',
                        function(content) {
                            refreshState();
                        },
                        {
                            command: state.val
                        }
                    );
                } else if (allowedCommandsPrinter.indexOf(state.val) > -1) {
                    adapter.log.debug('sending printer command: ' + state.val);

                    buildRequest(
                        'printer/printhead',
                        function(content) {
                            refreshState();
                        },
                        {
                            command: state.val,
                            axes: ['x', 'y', 'z']
                        }
                    );
                } else {
                    adapter.log.error('printer command not allowed: ' + state.val);
                }
            } else if (id == adapter.namespace + '.command.printjob') {

                var allowedCommands = ['start', 'cancel', 'restart', 'pause'];

                if (allowedCommands.indexOf(state.val) > -1) {
                    adapter.log.debug('sending printer command: ' + state.val);

                    buildRequest(
                        'job',
                        function(content) {
                            refreshState();
                        },
                        {
                            command: state.val
                        }
                    );
                } else {
                    adapter.log.error('print job command not allowed: ' + state.val);
                }
                
            }
        } else {
            adapter.log.error('OctoPrint API not connected');
        }
    }
});

adapter.on('message', function (obj) {
    if (typeof obj === 'object' && obj.message) {
        if (obj.command === 'send') {
            // e.g. send email or pushover or whatever
            console.log('send command');

            // Send response in callback if required
            if (obj.callback) adapter.sendTo(obj.from, obj.command, 'Message received', obj.callback);
        }
    }
});

function main() {
    adapter.subscribeStates('*');
    adapter.setState('printer_status', {val: printerStatus, ack: true});

    // Refresh State every Minute
    refreshState();
    setInterval(refreshState, 60000);
}

function setPrinterOffline() {
    adapter.setState('info.connection', false, true);
    conntected = false;
    printerStatus = 'Disconnected';
    adapter.setState('printer_status', {val: printerStatus, ack: true});
}

function refreshState() {
    adapter.log.debug('refreshing OctoPrint state');

    buildRequest(
        'version',
        function (content) {
            adapter.setState('info.connection', true, true);
            conntected = true;

            adapter.setState('meta.version', {val: content.server, ack: true});
            adapter.setState('meta.api_version', {val: content.api, ack: true});
        },
        null
    );

    if (conntected) {
        buildRequest(
            'connection',
            function (content) {
                printerStatus = content.current.state;
                adapter.setState('printer_status', {val: printerStatus, ack: true});
            },
            null
        );

        buildRequest(
            'printer',
            function (content) {
                for (var key in content.temperature) {
                    var obj = content.temperature[key];

                    if (key.indexOf('tool') > -1 || key == 'bed') { // Tool + bed information

                        // Create tool channel
                        adapter.setObjectNotExists('temperature.' + key, {
                            type: 'channel',
                            common: {
                                name: key,
                            },
                            native: {}
                        });

                        // Set actual temperature
                        adapter.setObjectNotExists('temperature.' + key + '.actual', {
                            type: 'state',
                            common: {
                                name: 'Actual',
                                type: 'number',
                                role: 'value.temperature',
                                unit: '°C',
                                read: true,
                                write: false
                            },
                            native: {}
                        });
                        adapter.setState('temperature.' + key + '.actual', {val: obj.actual, ack: true});

                        // Set target temperature
                        adapter.setObjectNotExists('temperature.' + key + '.target', {
                            type: 'state',
                            common: {
                                name: 'Target',
                                type: 'number',
                                role: 'value.temperature',
                                unit: '°C',
                                read: true,
                                write: true
                            },
                            native: {}
                        });
                        adapter.setState('temperature.' + key + '.target', {val: obj.target, ack: true});

                        // Set offset temperature
                        adapter.setObjectNotExists('temperature.' + key + '.offset', {
                            type: 'state',
                            common: {
                                name: 'Offset',
                                type: 'number',
                                role: 'value.temperature',
                                unit: '°C',
                                read: true,
                                write: false
                            },
                            native: {}
                        });
                        adapter.setState('temperature.' + key + '.offset', {val: obj.target, ack: true});
                    }
                }
            },
            null
        );

        buildRequest(
            'job',
            function (content) {
                if (content.job) {
                    adapter.setState('printjob.file.name', {val: content.job.file.name, ack: true});
                    adapter.setState('printjob.file.origin', {val: content.job.file.origin, ack: true});
                    adapter.setState('printjob.file.size', {val: content.job.file.size, ack: true});
                    adapter.setState('printjob.file.date', {val: content.job.file.date, ack: true});

                    if (content.job.filament) {
                        adapter.setState('printjob.filament.length', {val: content.job.filament.length, ack: true});
                        adapter.setState('printjob.filament.volume', {val: content.job.filament.volume, ack: true});
                    }
                }

                if (content.progress) {
                    adapter.setState('printjob.progress.completion', {val: content.progress.completion, ack: true});
                    adapter.setState('printjob.progress.filepos', {val: content.progress.filepos, ack: true});
                    adapter.setState('printjob.progress.printtime', {val: content.progress.printTime, ack: true});
                    adapter.setState('printjob.progress.printtime_left', {val: content.progress.printTimeLeft, ack: true});
                }
            },
            null
        );
    }
}

function buildRequest(service, callback, data) {
    var url = 'http://' + adapter.config.octoprintIp + ':' + adapter.config.octoprintPort + '/api/' + service;

    adapter.log.debug('sending request to ' + url + ' with data: ' + JSON.stringify(data));

    request(
        {
            url: url,
            method: data ? "POST" : "GET",
            json: data ? data : true,
            headers: {
                "X-Api-Key": adapter.config.octoprintApiKey
            }
        },
        function(error, response, content) {
            if (!error && (response.statusCode == 200 || response.statusCode == 204)) {
               callback(content);
            } else if (error) {
                adapter.log.debug(error);

                setPrinterOffline();
            } else {
                adapter.log.debug('Status Code: ' + response.statusCode + ' / Content: ' + content);

                setPrinterOffline();
            }
        }
    );
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    startAdapter();
}