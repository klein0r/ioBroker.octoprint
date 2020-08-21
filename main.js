/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */
'use strict';

const utils = require('@iobroker/adapter-core');
const axios = require('axios');

class OctoPrint extends utils.Adapter {

    constructor(options) {
        super({
            ...options,
            name: 'octoprint',
        });

        this.apiConnected = false;
        this.printerStatus = 'API not connected';
        this.systemCommands = [];

        this.refreshStateTimeout = null;
        this.refreshFilesTimeout = null;

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        this.subscribeStates('*');
        this.setState('printer_status', {val: this.printerStatus, ack: true});

        await this.refreshState();
        await this.refreshFiles();
    }

    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            this.setPrinterOffline(false);

            if (this.refreshStateTimeout) {
                this.log.debug('clearing refresh state timeout');
                clearTimeout(this.refreshStateTimeout);
            }

            if (this.refreshFilesTimeout) {
                this.log.debug('clearing refresh files timeout');
                clearTimeout(this.refreshFilesTimeout);
            }

            this.log.debug('cleaned everything up...');
            callback();
        } catch {
            callback();
        }
    }

    /**
     * Is called if a subscribed state changes
     * @param {string} id
     * @param {ioBroker.State | null | undefined} state
     */
    onStateChange(id, state) {
        if (state && !state.ack) {
            const cleanId = id.split('.').slice(2).join('.');

            // No ack = changed by user
            if (this.apiConnected) {
                if (id.match(new RegExp(this.namespace + '.temperature.tool[0-9]{1}.target'))) {

                    this.log.debug('changing target tool temperature to ' + state.val);

                    // TODO: Check which tool has been changed
                    this.buildRequest(
                        'printer/tool',
                        (content, status) => {
                            if (status == 204) {
                                this.setState(cleanId, {val: state.val, ack: true});
                            } else {
                                // 400 Bad Request – If targets or offsets contains a property or tool contains a value not matching the format tool{n}, the target/offset temperature, extrusion amount or flow rate factor is not a valid number or outside of the supported range, or if the request is otherwise invalid.
                                // 409 Conflict – If the printer is not operational or – in case of select or extrude – currently printing.

                                this.log.error(content);
                            }
                        },
                        {
                            command: 'target',
                            targets: {
                                tool0: state.val
                            }
                        }
                    );

                } else if (id === this.namespace + '.temperature.bed.target') {

                    this.log.debug('changing target bed temperature to ' + state.val);

                    this.buildRequest(
                        'printer/bed',
                        (content, status) => {
                            if (status == 204) {
                                this.setState(cleanId, {val: state.val, ack: true});
                            } else {
                                // 400 Bad Request – If target or offset is not a valid number or outside of the supported range, or if the request is otherwise invalid.
                                // 409 Conflict – If the printer is not operational or the selected printer profile does not have a heated bed.

                                this.log.error(content);
                            }
                        },
                        {
                            command: 'target',
                            target: state.val
                        }
                    );

                } else if (id === this.namespace + '.command.printer') {

                    const allowedCommandsConnection = ['connect', 'disconnect', 'fake_ack'];
                    const allowedCommandsPrinter = ['home'];

                    if (allowedCommandsConnection.indexOf(state.val) > -1) {
                        this.log.debug('sending printer connection command: ' + state.val);

                        this.buildRequest(
                            'connection',
                            (content, status) => {
                                if (status == 204) {
                                    this.setState(cleanId, {val: state.val, ack: true});
                                    this.refreshState();
                                } else {
                                    // 400 Bad Request – If the selected port or baudrate for a connect command are not part of the available options.

                                    this.log.error(content);
                                }
                            },
                            {
                                command: state.val
                            }
                        );
                    } else if (allowedCommandsPrinter.indexOf(state.val) > -1) {

                        this.log.debug('sending printer command: ' + state.val);

                        this.buildRequest(
                            'printer/printhead',
                            (content, status) => {
                                if (status == 204) {
                                    this.setState(cleanId, {val: state.val, ack: true});
                                } else {
                                    // 400 Bad Request – Invalid axis specified, invalid value for travel amount for a jog command or factor for feed rate or otherwise invalid request.
                                    // 409 Conflict – If the printer is not operational or currently printing.

                                    this.log.error(content);
                                }
                            },
                            {
                                command: state.val,
                                axes: ['x', 'y', 'z']
                            }
                        );
                    } else {
                        this.log.error('printer command not allowed: ' + state.val + '. Choose one of: ' + allowedCommandsConnection.concat(allowedCommandsPrinter).join(', '));
                    }

                } else if (id === this.namespace + '.command.printjob') {

                    const allowedCommands = ['start', 'cancel', 'restart'];

                    if (allowedCommands.indexOf(state.val) > -1) {
                        this.log.debug('sending printjob command: ' + state.val);

                        this.buildRequest(
                            'job',
                            (content, status) => {
                                if (status == 204) {
                                    this.setState(cleanId, {val: state.val, ack: true});
                                } else {
                                    // 409 Conflict – If the printer is not operational or the current print job state does not match the preconditions for the command.

                                    this.log.error(content);
                                }
                            },
                            {
                                command: state.val
                            }
                        );
                    } else {
                        this.log.error('print job command not allowed: ' + state.val + '. Choose one of: ' + allowedCommands.join(', '));
                    }

                } else if (id === this.namespace + '.command.sd') {

                    const allowedCommands = ['init', 'refresh', 'release'];

                    if (allowedCommands.indexOf(state.val) > -1) {
                        this.log.debug('sending sd card command: ' + state.val);

                        this.buildRequest(
                            'printer/sd',
                            (content, status) => {
                                if (status == 204) {
                                    this.setState(cleanId, {val: state.val, ack: true});
                                } else {
                                    // 409 Conflict – If a refresh or release command is issued but the SD card has not been initialized (e.g. via init).

                                    this.log.error(content);
                                }
                            },
                            {
                                command: state.val
                            }
                        );
                    } else {
                        this.log.error('print job command not allowed: ' + state.val + '. Choose one of: ' + allowedCommands.join(', '));
                    }

                } else if (id === this.namespace + '.command.custom') {

                    this.log.debug('sending custom command: ' + state.val);

                    this.buildRequest(
                        'printer/command',
                        (content, status) => {
                            if (status == 204) {
                                this.setState(cleanId, {val: state.val, ack: true});
                            } else {
                                this.log.error(content);
                            }
                        },
                        {
                            command: state.val
                        }
                    );

                } else if (id === this.namespace + '.command.system') {

                    if (this.systemCommands.indexOf(state.val) > -1) {
                        this.log.debug('sending system command: ' + state.val);

                        this.buildRequest(
                            'system/commands/' + state.val,
                            (content, status) => {
                                if (status == 204) {
                                    this.setState(cleanId, {val: state.val, ack: true});
                                } else {
                                    // 400 Bad Request – If a divider is supposed to be executed or if the request is malformed otherwise
                                    // 404 Not Found – If the command could not be found for source and action
                                    // 500 Internal Server Error – If the command didn’t define a command to execute, the command returned a non-zero return code and ignore was not true or some other internal server error occurred

                                    this.log.error(content);
                                }
                            },
                            {}
                        );
                    } else {
                        this.log.error('system command not allowed: ' + state.val + '. Choose one of: ' + this.systemCommands.join(', '));
                    }
                } else if (id.indexOf(this.namespace + '.command.jog.') === 0) {

                    const axis = id.split('.').pop(); // Last element of the id is the axis
                    const jogCommand = {
                        command: 'jog',
                    };

                    // Add axis
                    jogCommand[axis] = state.val;

                    this.log.debug('sending jog ' + axis + ' command: ' + state.val);

                    this.buildRequest(
                        'printer/printhead',
                        (content, status) => {
                            if (status == 204) {
                                this.setState(cleanId, {val: state.val, ack: true});
                            } else {
                                // 400 Bad Request – Invalid axis specified, invalid value for travel amount for a jog command or factor for feed rate or otherwise invalid request.
                                // 409 Conflict – If the printer is not operational or currently printing.

                                this.log.error(content);
                            }
                        },
                        jogCommand
                    );

                }
            } else {
                this.log.error('OctoPrint API not connected');
            }
        }
    }

    setPrinterOffline(connection) {
        this.setState('info.connection', connection, true);
        this.apiConnected = connection;

        if (!connection) {
            this.printerStatus = 'API not connected';
            this.setState('printer_status', {val: this.printerStatus, ack: true});
        }
    }

    async refreshState() {
        this.log.debug('refreshing OctoPrint state');

        await this.buildRequest(
            'version',
            (content, status) => {
                this.setState('info.connection', true, true);
                this.apiConnected = true;

                this.log.debug('connected to OctoPrint API - online!');

                this.setState('meta.version', {val: content.server, ack: true});
                this.setState('meta.api_version', {val: content.api, ack: true});
            },
            null
        );

        if (this.apiConnected) {
            this.buildRequest(
                'connection',
                (content, status) => {
                    this.printerStatus = content.current.state;
                    this.setState('printer_status', {val: this.printerStatus, ack: true});
                },
                null
            );

            this.buildRequest(
                'printer',
                (content, status) => {
                    if (typeof content === 'object' && Object.prototype.hasOwnProperty.call(content, 'temperature')) {
                        for (const key of Object.keys(content.temperature)) {
                            const obj = content.temperature[key];

                            if (key.indexOf('tool') > -1 || key == 'bed') { // Tool + bed information

                                // Create tool channel
                                try {
                                    this.setObjectNotExists('temperature.' + key, {
                                        type: 'channel',
                                        common: {
                                            name: key,
                                        },
                                        native: {}
                                    });

                                    // Set actual temperature
                                    this.setObjectNotExists('temperature.' + key + '.actual', {
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

                                    // Set target temperature
                                    this.setObjectNotExists('temperature.' + key + '.target', {
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

                                    // Set offset temperature
                                    this.setObjectNotExists('temperature.' + key + '.offset', {
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
                                } catch (e) {
                                    this.log.error(`Could not create temperature objects: ${e}`);
                                }

                                this.setState('temperature.' + key + '.actual', {val: obj.actual, ack: true});
                                this.setState('temperature.' + key + '.target', {val: obj.target, ack: true});
                                this.setState('temperature.' + key + '.offset', {val: obj.target, ack: true});
                            }
                        }
                    }
                },
                null
            );

            /*
            this.buildRequest(
                'printer/command/custom',
                (content, status) => {
                    // Todo
                },
                null
            );
            */

            this.buildRequest(
                'system/commands',
                (content, status) => {
                    this.systemCommands = [];

                    for (const key of Object.keys(content)) {
                        const arr = content[key];
                        arr.forEach(e => this.systemCommands.push(e.source + '/' + e.action));
                    }

                    this.log.debug('Registered system commands: ' + this.systemCommands.join(', '));
                },
                null
            );

            this.buildRequest(
                'job',
                (content, status) => {
                    if (Object.prototype.hasOwnProperty.call(content, 'job') && Object.prototype.hasOwnProperty.call(content.job, 'file')) {
                        this.setState('printjob.file.name', {val: content.job.file.name, ack: true});
                        this.setState('printjob.file.origin', {val: content.job.file.origin, ack: true});
                        this.setState('printjob.file.size', {val: content.job.file.size, ack: true});
                        this.setState('printjob.file.date', {val: content.job.file.date, ack: true});

                        if (Object.prototype.hasOwnProperty.call(content.job, 'filament') && content.job.filament) {
                            this.setState('printjob.filament.length', {val: content.job.filament.length, ack: true});
                            this.setState('printjob.filament.volume', {val: content.job.filament.volume, ack: true});
                        }
                    }

                    if (Object.prototype.hasOwnProperty.call(content, 'progress')) {
                        this.setState('printjob.progress.completion', {val: content.progress.completion, ack: true});
                        this.setState('printjob.progress.filepos', {val: content.progress.filepos, ack: true});
                        this.setState('printjob.progress.printtime', {val: content.progress.printTime, ack: true});
                        this.setState('printjob.progress.printtime_left', {val: content.progress.printTimeLeft, ack: true});
                    }
                },
                null
            );
        }

        this.log.debug('re-creating refresh state timeout');

        clearTimeout(this.refreshStateTimeout);
        this.refreshStateTimeout = setTimeout(this.refreshState.bind(this), 30000);
    }

    async refreshFiles() {

        if (this.apiConnected) {
            this.buildRequest(
                'files?recursive=true',
                (content, status) => {

                    let counter = 0;

                    content.files.forEach(function(file) {

                        this.setObjectNotExists('files.' + counter, {
                            type: 'channel',
                            common: {
                                name: 'File ' + (counter + 1),
                            },
                            native: {}
                        });

                        this.setObjectNotExists('files.' + counter + '.name', {
                            type: 'state',
                            common: {
                                name: 'File name',
                                type: 'string',
                                role: 'value',
                                read: true,
                                write: false
                            },
                            native: {}
                        });
                        this.setState('files.' + counter + '.name', {val: file.display, ack: true});

                        this.setObjectNotExists('files.' + counter + '.date', {
                            type: 'state',
                            common: {
                                name: 'File date',
                                type: 'string',
                                role: 'value',
                                read: true,
                                write: false
                            },
                            native: {}
                        });
                        this.setState('files.' + counter + '.date', {val: new Date(file.date * 1000).toLocaleDateString('de-DE'), ack: true});

                        counter++;
                    }.bind(this));

                },
                null
            );
        } else {
            this.log.error('OctoPrint API not connected');
        }

        this.log.debug('re-creating refresh state timeout');

        clearTimeout(this.refreshFilesTimeout);
        this.refreshFilesTimeout = setTimeout(this.refreshState.bind(this), 60000 * 5); // Every 5 Minutes
    }

    async buildRequest(service, callback, data) {
        const url = '/api/' + service;
        const method = data ? 'post' : 'get';

        this.log.debug('sending ' + method + ' request to ' + url + ' with data: ' + JSON.stringify(data));

        await axios({
            method: method,
            data: data,
            baseURL: 'http://' + this.config.octoprintIp + ':' + this.config.octoprintPort,
            url: url,
            responseType: 'json',
            headers: {
                'X-Api-Key': this.config.octoprintApiKey
            },
            validateStatus: function (status) {
                return [200, 204, 409].indexOf(status) > -1;
            },
        }).then(
            function (response) {
                this.log.debug('received ' + response.status + ' response from ' + url + ' with content: ' + JSON.stringify(response.data));
    
                if (response && callback && typeof callback === 'function') {
                    callback(response.data, response.status);
                }
            }.bind(this)
        ).catch(
            function (error) {
                this.log.error(error);
            }.bind(this)
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
