#!/usr/bin/env node

var fs = require("fs");
var url = require("url");
var path = require("path");

var validurl = require("valid-url").is_web_uri;
var request = require("request");
var mkdirp = require("mkdirp");
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

// run
require("./lib/banish.js")(config);
