/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

const utils = require('@iobroker/adapter-core');
const request = require('request');

class OctoPrint extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: 'octoprint',
        });
        this.on('ready', this.onReady.bind(this));
        this.on('objectChange', this.onObjectChange.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));

        this.connected = false;
        this.printerStatus = 'Disconnected';
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.subscribeStates('*');
        this.setState('printer_status', {val: this.printerStatus, ack: true});

        // Refresh State every Minute
        this.refreshState();
        setInterval(this.refreshState.bind(this), 60000);
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setPrinterOffline(false);
            this.log.debug('cleaned everything up...');
            callback();
        } catch (e) {
            callback();
        }
    }

    /**
     * Is called if a subscribed object changes
     * @param {string} id
     * @param {ioBroker.Object | null | undefined} obj
     */
    onObjectChange(id, obj) {
        if (obj) {
            // The object was changed
            this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);
        } else {
            // The object was deleted
            this.log.info(`object ${id} deleted`);
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        var self = this;

        if (state && !state.ack) {
            // No ack = changed by user
            if (this.connected) {
                if (id.match(new RegExp(this.namespace + '\.temperature\.tool[0-9]{1}\.target'))) {
                    this.log.debug('changing target tool temperature to ' + state.val);
    
                    // TODO: Check which tool has been changed
                    this.buildRequest(
                        'printer/tool',
                        function(content) {
                            //self.refreshState();
                        },
                        {
                            command: 'target',
                            targets: {
                                tool0: state.val
                            }
                        }
                    );
                } else if (id == this.namespace + '.temperature.bed.target') {
                    this.log.debug('changing target bed temperature to ' + state.val);
    
                    this.buildRequest(
                        'printer/bed',
                        function(content) {
                            //self.refreshState();
                        },
                        {
                            command: 'target',
                            target: state.val
                        }
                    );
                } else if (id == this.namespace + '.command.printer') {
    
                    var allowedCommandsConnection = ['connect', 'disconnect', 'fake_ack'];
                    var allowedCommandsPrinter = ['home'];
    
                    if (allowedCommandsConnection.indexOf(state.val) > -1) {
                        this.log.debug('sending printer connection command: ' + state.val);
    
                        this.buildRequest(
                            'connection',
                            function(content) {
                                //self.refreshState();
                            },
                            {
                                command: state.val
                            }
                        );
                    } else if (allowedCommandsPrinter.indexOf(state.val) > -1) {
                        this.log.debug('sending printer command: ' + state.val);
    
                        this.buildRequest(
                            'printer/printhead',
                            function(content) {
                                //self.refreshState();
                            },
                            {
                                command: state.val,
                                axes: ['x', 'y', 'z']
                            }
                        );
                    } else {
                        this.log.error('printer command not allowed: ' + state.val);
                    }
                } else if (id == this.namespace + '.command.printjob') {

                    var allowedCommands = ['start', 'cancel', 'restart', 'pause'];

                    if (allowedCommands.indexOf(state.val) > -1) {
                        this.log.debug('sending printer command: ' + state.val);

                        this.buildRequest(
                            'job',
                            function(content) {
                                //self.refreshState();
                            },
                            {
                                command: state.val
                            }
                        );
                    } else {
                        this.log.error('print job command not allowed: ' + state.val);
                    }
                    
                }
            } else {
                this.log.error('OctoPrint API not connected');
            }
        }
    }

    setPrinterOffline(connection) {
        this.setState('info.connection', connection, true);
        this.connected = connection;

        if (!connection) {
            this.printerStatus = 'Disconnected';
            this.setState('printer_status', {val: this.printerStatus, ack: true});
        }
    }

    refreshState() {
        this.log.debug('refreshing OctoPrint state');
        var self = this;

        this.buildRequest(
            'version',
            function (content) {
                self.setState('info.connection', true, true);
                self.connected = true;
    
                self.setState('meta.version', {val: content.server, ack: true});
                self.setState('meta.api_version', {val: content.api, ack: true});
            },
            null
        );

        if (this.connected) {
            this.buildRequest(
                'connection',
                function (content) {
                    self.printerStatus = content.current.state;
                    self.setState('printer_status', {val: self.printerStatus, ack: true});
                },
                null
            );

            this.buildRequest(
                'printer',
                function (content) {
                    for (var key in content.temperature) {
                        var obj = content.temperature[key];

                        if (key.indexOf('tool') > -1 || key == 'bed') { // Tool + bed information

                            // Create tool channel
                            self.setObjectNotExists('temperature.' + key, {
                                type: 'channel',
                                common: {
                                    name: key,
                                },
                                native: {}
                            });

                            // Set actual temperature
                            self.setObjectNotExists('temperature.' + key + '.actual', {
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
                            self.setState('temperature.' + key + '.actual', {val: obj.actual, ack: true});

                            // Set target temperature
                            self.setObjectNotExists('temperature.' + key + '.target', {
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
                            self.setState('temperature.' + key + '.target', {val: obj.target, ack: true});

                            // Set offset temperature
                            self.setObjectNotExists('temperature.' + key + '.offset', {
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
                            self.setState('temperature.' + key + '.offset', {val: obj.target, ack: true});
                        }
                    }
                },
                null
            );

            this.buildRequest(
                'job',
                function (content) {
                    if (content.job) {
                        self.setState('printjob.file.name', {val: content.job.file.name, ack: true});
                        self.setState('printjob.file.origin', {val: content.job.file.origin, ack: true});
                        self.setState('printjob.file.size', {val: content.job.file.size, ack: true});
                        self.setState('printjob.file.date', {val: content.job.file.date, ack: true});
    
                        if (content.job.filament) {
                            self.setState('printjob.filament.length', {val: content.job.filament.length, ack: true});
                            self.setState('printjob.filament.volume', {val: content.job.filament.volume, ack: true});
                        }
                    }

                    if (content.progress) {
                        self.setState('printjob.progress.completion', {val: content.progress.completion, ack: true});
                        self.setState('printjob.progress.filepos', {val: content.progress.filepos, ack: true});
                        self.setState('printjob.progress.printtime', {val: content.progress.printTime, ack: true});
                        self.setState('printjob.progress.printtime_left', {val: content.progress.printTimeLeft, ack: true});
                    }
                },
                null
            );
        }
    }

    buildRequest(service, callback, data) {
        var url = 'http://' + this.config.octoprintIp + ':' + this.config.octoprintPort + '/api/' + service;
        var self = this;

        this.log.debug('sending request to ' + url + ' with data: ' + JSON.stringify(data));

        request(
            {
                url: url,
                method: data ? "POST" : "GET",
                json: data ? data : true,
                headers: {
                    "X-Api-Key": this.config.octoprintApiKey
                }
            },
            function(error, response, content) {
                if (!error && response.statusCode == 409) { // Printer is not operational
                    self.setPrinterOffline(true);
                } else if (!error && (response.statusCode == 200 || response.statusCode == 204)) {
                   callback(content);
                } else if (error) {
                    self.log.debug(error);
    
                    self.setPrinterOffline(false);
                } else {
                    self.log.debug('Status Code: ' + response.statusCode + ' / Content: ' + content);
    
                    self.setPrinterOffline(false);
                }
            }
        );
    }
}

// @ts-ignore parent is a valid property on module
if (module.parent) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<ioBroker.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new OctoPrint(options);
} else {
    // otherwise start the instance directly
    new OctoPrint();
}