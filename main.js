/* jshint -W097 */// jshint strict:false
/*jslint node: true */
'use strict';

var utils = require(__dirname + '/lib/utils');
var request = require('request');

var adapter = new utils.Adapter('octoprint');

var conntected = false;
var printerStatus = 'Disconnected';

adapter.on('unload', function (callback) {
    try {
        adapter.setState('info.connection', false, true);
        conntected = false;
        printerStatus = 'Disconnected';
        adapter.setState('printer_status', {val: printerStatus, ack: true});

        callback();
    } catch (e) {
        callback();
    }
});

adapter.on('objectChange', function (id, obj) {
    // Warning, obj can be null if it was deleted
    adapter.log.info('objectChange ' + id + ' ' + JSON.stringify(obj));
});

adapter.on('stateChange', function (id, state) {
if (state && !state.ack) {
        // No ack = changed by user
        if (conntected) {
            if (id.match(new RegExp(adapter.namespace + '\.temperature\.tool[0-9]{1}\.target'))) {
                adapter.log.info('changing target tool temperature to ' + state.val);

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
            } else if (id == adapter.namespace + 'temperature.bed.target') {
                adapter.log.info('changing target bed temperature to ' + state.val);

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
            }
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

adapter.on('ready', function () {
    main();
});

function main() {
    adapter.subscribeStates('*');
    adapter.setState('printer_status', {val: printerStatus, ack: true});

    // Refresh State every Minute
    refreshState();
    setInterval(refreshState, 60000);
}

function refreshState()
{
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
            'printer',
            function (content) {
                printerStatus = content.state.text;
                adapter.setState('printer_status', {val: printerStatus, ack: true});

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
                                role: 'value',
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
                                role: 'value',
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
                                role: 'value',
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
    }
}

function buildRequest(service, callback, data)
{
    var url = 'http://' + adapter.config.octoprintIp + ':' + adapter.config.octoprintPort + '/api/' + service;

    adapter.log.info('sending request to ' + url + ' with data: ' + JSON.stringify(data));

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
                adapter.log.error(error);
            } else {
                adapter.log.error('Status Code: ' + response.statusCode + ' / Content: ' + content);
            }
        }
    );
}