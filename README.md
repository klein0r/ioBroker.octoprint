![Logo](admin/octoprint.png)

# ioBroker.octoprint

[![NPM version](http://img.shields.io/npm/v/iobroker.octoprint.svg)](https://www.npmjs.com/package/iobroker.octoprint)
[![Downloads](https://img.shields.io/npm/dm/iobroker.octoprint.svg)](https://www.npmjs.com/package/iobroker.octoprint)
[![Stable](http://iobroker.live/badges/octoprint-stable.svg)](http://iobroker.live/badges/octoprint-stable.svg)
[![Installed](http://iobroker.live/badges/octoprint-installed.svg)](http://iobroker.live/badges/octoprint-installed.svg)
[![Known Vulnerabilities](https://snyk.io/test/github/klein0r/ioBroker.octoprint/badge.svg)](https://snyk.io/test/github/klein0r/ioBroker.octoprint)
![Test and Release](https://github.com/klein0r/ioBroker.octoprint/workflows/Test%20and%20Release/badge.svg)

[![NPM](https://nodei.co/npm/iobroker.octoprint.png?downloads=true)](https://nodei.co/npm/iobroker.octoprint/)

Adapter to connect OctoPrint to ioBroker

## Installation

Please use the "adapter list" in ioBroker to install a stable version of this adapter. You can also use the CLI to install this adapter:

```
iobroker add octoprint
```

## Documentation

[🇺🇸 Documentation](./docs/en/basics.md)

[🇩🇪 Dokumentation](./docs/de/basics.md)

## Sentry

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** For more details and for information how to disable the error reporting see [Sentry-Plugin Documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry)! Sentry reporting is used starting with js-controller 3.0.

## Changelog

<!--
  Placeholder for the next version (at the beginning of the line):
  ### **WORK IN PROGRESS**
-->
### 4.0.0 (2022-05-19)

NodeJS 14.x is required (NodeJS 12.x is EOL)

Tested with OctoPrint 1.8.0

* (klein0r) Added last and average layer duration (requires plugin Display Layer Progress)
* (klein0r) Moved thumbnail information of files to new structure **(BREAKING CHANGE - CHECK YOUR SCRIPTS AND VIS)**
* (klein0r) Improved handling of thumbnails and states for plugins

### 3.2.2 (2022-04-29)

* (klein0r) Updated depedency for js-controller to 4.0.15

### 3.2.1 (2022-04-28)

* (klein0r) Get thumbnail url of current file and copy value to printjob (requires plugin Slicer Thumbnails)
* (klein0r) Updated log messages

### 3.2.0 (2022-03-07)

Tested with OctoPrint 1.7.3

* (klein0r) Added print times as readable states (seconds to string)
* (klein0r) Added formatted date when print job will finish
* (klein0r) Added fan speed and feedrate from plugin Display Layer Progress

### 3.1.0 (2022-02-24)

* (klein0r) Calculate date/time when print will be finished
* (klein0r) Renamed ``printjob.progress.printtime_left`` to ``printjob.progress.printtimeLeft`` **(BREAKING CHANGE - CHECK YOUR SCRIPTS AND VIS)**

## License

The MIT License (MIT)

Copyright (c) 2022 Matthias Kleine <info@haus-automatisierung.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
