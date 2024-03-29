#!/usr/bin/env node

var fs = require("fs");
var url = require("url");
var path = require("path");

var validurl = require("valid-url").is_web_uri;
var debug = require("debug")("banish");

// get config
try {
	var config = {
		url: process.argv[2] || "http://localhost:2368/",
		dest: path.resolve(process.cwd(), process.argv[3] || "html"),
	};
} catch (err) {
	return console.error(err), process.exit(1);
};

if (!validurl(config.url)) return console.error("invalid url: %s", config.url), process.exit(1)

debug("download folder: %s", config.dest);

config.lockfile = path.resolve(config.dest, '.banish.lock');
if (fs.existsSync(config.lockfile)) console.error('lockfile exists: '+config.lockfile), process.exit(1);

// run
require("./lib/banish.js")(config);
