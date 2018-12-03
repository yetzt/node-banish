#!/usr/bin/env node

var gzip = require("zlib").gzip;
var path = require("path");
var url = require("url");
var fs = require("fs");

var request = require("request");
var cheerio = require("cheerio");
var jsonic = require("jsonic");
var mkdirp = require("mkdirp");
var queue = require("queue");
var debug = require("debug")("banish");
var rmrf = require("rimraf");

var zopfli = require("node-zopfli-es").createGzip;
var htmlmin = require("html-minifier").minify;
var cssmin = require("clean-css");
var cssurl = require("css-url-parser");
var jsmin = require("uglify-js").minify;
var jpegmin = require("js-mozjpeg").jpegtran;
var pngmin = require("optipng-js");

function banish(opts, fn) {
	return (this instanceof banish) ? ((this.opts=opts),this.run(fn)) : new banish(opts, fn);
};

// run things
banish.prototype.run = function(fn){
	var self = this;
	
	if (typeof fn !== 'function') var fn = function(){};
	
	self.resume(function(err){
		if (err) debug("error resuming: %s", err); // start with empty cache

		(function(next){
			if (!err && !!self.cache.credentials) return next(false);
			
			// build new cache
			request({
				method: "GET",
				url: self.opts.url,
				headers: { "x-banish": "1" }
			}, function(err, resp, data){
				if (err) return fn(err);
				if (resp.statusCode !== 200) return fn(new Error('HTTP Status '+resp.statusCode));
		
				// parse site
				try {
					var $ = cheerio.load(data);
				} catch (err) {
					return fn(err);
				}
				
				// check metatag
				if (!/^Ghost/.test($('meta[name="generator"]').first().attr('content'))) return fn(new Error("no ghost generator meta tag"));
		
				// check for linked data json
				if ($('script[type="application/ld+json"]').length !== 1) return fn(new Error("jsonld not present"));
		
				try {
					self.ld = JSON.parse($('script[type="application/ld+json"]').html());
				} catch (err) {
					return fn(new Error("error parsing jsonld: "+err));
				}

				if (self.ld.mainEntityOfPage['@id'] !== self.opts.url.replace(/\/?$/,'/')) debug("jsonld/url mismatch: %s <-> %s", self.ld.mainEntityOfPage['@id'], self.opts.url);
				
				// cache linked data url
				self.cache.url = self.ld.mainEntityOfPage['@id'];

				// get api credentials
				try {
					self.cache.credentials = $('head script').map(function(i,e){
						return $(e).html().replace(/\s+/g,'');
					}).filter(function(i,e){
						return /ghost\.init/.test(e);
					}).map(function(i,e){
						return jsonic(e.replace(/^.*ghost\.init\(([^\)]+)\);.*$/g,'$1'));
					}).get(0);
				} catch (err) {
					return fn(new Error("error extracting credentials: "+err));
				}
				
				next(true);
		
			});
			
		})(function(fresh){

			// prepare queue and queue check
			self.q = queue({ concurrency: 5 });
			self.qck = {};

			// compression queue
			self.zqueue = [];

			// write cache to disk
			fs.writeFile(self.opts.configfile, JSON.stringify(self.cache), function(err){
				if (err) debug("could not write cache file: %s", err);

				// add known resources to queue
				self.queue(self.cache.url);
				
				self.collect(function(err){
					if (err) debug("[collect] collection failed: %s", err);

					self.q.start(function(err){
						if (err) debug("[fetch] run abort: %s", err);
						debug("[fetch] complete");
						
						// compress
						debug("[compression] %d files queued", self.zqueue.length);
						self.compress(function(err){
							if (err) debug("compression error: %s", err);

							fs.writeFile(self.opts.configfile, JSON.stringify(self.cache), function(err){
								if (err) debug("could not write cache file: %s", err);
								debug("all done");
								return fn(null);
							});
							
						});
						
					});
					
				});

			});

		});
		
	});
	
	return this;
};

// get last state from file
banish.prototype.resume = function(fn){
	var self = this;

	// ensure path is directory; generate config path
	self.opts.dest = self.opts.dest.replace("/?$","/");
	self.opts.configfile = path.resolve(self.opts.dest, ".banish.json");
	
	self.cache = { 
		url: self.opts.url,
		credentials: null 
	};
	
	// ensure dir exists
	mkdirp(self.opts.dest, function(err){
		if (err) return fn(err);

		fs.exists(self.opts.configfile, function(ex){
			if (!ex) return fn(null);
			
			fs.readFile(self.opts.configfile, function(err, conf){
				if (err) return fn(err);
				try {
					conf = JSON.parse(conf);
				} catch (err) {
					return fn(err);
				}
				self.cache = Object.assign(self.cache, conf);
				fn(null);
			});
		});
	});
	
	return this;
};

// collect articles
banish.prototype.collect = function(fn){
	var self = this;
	
	request({
		method: "GET",
		url: url.resolve(self.cache.url, "ghost/api/v0.1/posts/"),
		qs: {
			client_id: self.cache.credentials.clientId,
			client_secret: self.cache.credentials.clientSecret,
			order: "updated_at desc",
			fields: "url,updated_at,id",
			limit: "all",
			absolute_urls: "true",
			filter: 'status:published,page:[true,false]',
			// FIXME: filter for updated_at to relief strain on query
		},
		headers: { "x-banish": "1" }
	}, function(err, resp, data){
		if (err) return fn(err);
				
		if (resp.statusCode !== 200) return fn(new Error("Status Code: "+resp.statusCode));
		
		try {
			data = JSON.parse(data);
		} catch (err) {
			return fn(err);
		}
		
		// queue posts
		var n = data.posts.filter(function(post){
			if (!!self.qck[post.url]) return false;
			if (!!self.cache[post.url] && !!self.cache[post.url].t >= (new Date(post.updated_at).valueOf())) return false;
			self.queue(post.url);
			return true;
		}).length;

		// here
		debug("collected %d posts", n);
		
		return fn(null);
		
	});
		
	return this;

};

// enqueue url
banish.prototype.queue = function(u){
	var self = this;

	if (!!self.qck[u]) return;
	self.qck[u] = true;
	
	self.q.push(function(done){
		self.urlpath(u, function(p){
			if (!p) return done();
			self.fetch(u, p, done);
		});
	});
	
	return this;
};

// fetch, parse and save url
banish.prototype.fetch = function(u, p, fn){
	var self = this;
	
	debug("fetching %s", u);
		
	var headers = {};
	if (!!self.cache[u]) {
		if (!!self.cache[u].e && !(self.cache[u].e instanceof Array)) self.cache[u].e = [ self.cache[u].e ];
		if (!!self.cache[u].e) headers["If-None-Match"] = self.cache[u].e.join(", ");
		if (!!self.cache[u].t) headers["If-Modified-Since"] = (new Date(self.cache[u].t)).toUTCString();
	};
	
	request({
		method: "GET",
		url: u,
		headers: Object.assign({ "x-banish": "1" }, headers),
		encoding: null, // receive buffer for better minification
	}, function(err, resp, content){
		debug("fetched %s", u)
		if (err) return debug("[fetch] error fetching '%s': %s", u, err), fn(null);
		if (resp.statusCode === 304) return debug("[fetch] not modified: '%s'", u), fn(null);
		if ([429,502,503,504,520,521].indexOf(resp.statusCode) >= 0) return debug("[fetch] backend not responding: '%s'", u), fn(null); // keep cache when server has trouble
		if (!resp.headers['content-type']) return debug("[fetch] no content type, no caching: '%s'", u), fn(null)

		// figure out filename
		var destfile = self.resolve(p, resp.headers['content-type'].split(/;/g).shift().toLowerCase());
		var destfilegz = destfile+".gz";

		// remove all urls containing errors from cache; we don't want to keep depublished pages
		if (resp.statusCode !== 200) return debug("[fetch] error fetching '%s': %s", u, new Error("Status Code "+resp.statusCode)), self.remove(u, destfile, fn);

		(function(write){

			// now lets see what we have
			switch (resp.headers['content-type'].split(/;/g).shift().toLowerCase()) {
				case "text/html":
					content = content.toString(); // make string

					// find more links with cheerio
					try {
						var $ = cheerio.load(content);
						
						$('[src]').each(function(i,e){
							self.queue(url.resolve(u, $(e).attr("src")));
						});
						$('[href]').each(function(i,e){
							self.queue(url.resolve(u, $(e).attr("href")));
						});
						
					} catch (err) {
						return debug("parse error: %s", err);
					}
					
					// html minify
					write(htmlmin(content, {
						collapseWhitespace: true,
						collapseInlineTagWhitespace: true,
						conservativeCollapse: true,
						decodeEntities: true,
						html5: true,
						minifyCSS: true,
						minifyJS: true,
						removeComments: true,
						useShortDoctype: true,
					}).replace(/target="[^"]+"\s*/g,''));
					
				break;
				case "text/css":
					
					content = content.toString(); // make string
					
					// find more links
					cssurl(content).forEach(function(cu){
						self.queue(url.resolve(u, cu));
					});

					var cont = (new cssmin({})).minify(content);

					// css minify
					write((cont.errors.length === 0 && (cont.stats.minifiedSize < cont.stats.originalSize)) ? cont.styles : content);

				break;
				case "application/javascript":
					// js minify
					write(jsmin(content.toString()));
				break;
				case "text/xml":
					// "compress" xml
					write(content.toString().replace(/\<![ \r\n\t]*(--([^\-]|[\r\n]|-[^\-])*--[ \r\n\t]*)\>/g, "").replace(/>\s{0,}</g, "><"));
				break;
				case "text/plain":
					// just gzip
					write(content);
				break;
				case "application/json":
					// "compress" json
					try {
						write(JSON.stringify(JSON.parse(content.toString()))
							.replace(/\s{0,}\{\s{0,}/g, "{")
							.replace(/\s{0,}\[$/g, "[")
							.replace(/\[\s{0,}/g, "[")
							.replace(/:\s{0,}\[/g, ':[')
							.replace(/\s{0,}\}\s{0,}/g, "}")
							.replace(/\s{0,}\]\s{0,}/g, "]")
							.replace(/\"\s{0,}\,/g, '",')
							.replace(/\,\s{0,}\"/g, ',"')
							.replace(/\"\s{0,}:/g, '":')
							.replace(/:\s{0,}\"/g, ':"')
							.replace(/:\s{0,}\[/g, ':[')
							.replace(/\,\s{0,}\[/g, ',[')
							.replace(/\,\s{2,}/g, ', ')
							.replace(/\]\s{0,},\s{0,}\[/g, '],['));
					} catch (err) {
						return write(content);
					};
				break;
				case "image/png":
					// FIXME: compression queue?

					// compress png
					try {
						write(pngmin(content, { o2: true, zc9: true, strip: "all" }).data)
					} catch (err) {
						debug("[pngmin] error: %s", err);
						write(content);
					}

				break;
				case "image/jpg":
				case "image/jpeg":
					// FIXME: compression queue?

					// compress jpeg
					try {
						write(jpegmin(content, { optimize: true }).data);
					} catch (err) {
						write(content);
					}
				break;
				default:
					write(content);
				break;
			}
			
		})(function(cont){
			debug("writing '%s'", destfile);
			
			mkdirp(path.dirname(destfile), function(err){
				if (err && err.code !== 'EEXIST') return debug("error creating dir for file '%s': %s", destfile, err), fn(null);
			
				// write file
				fs.writeFile(destfile, cont, function(err){
					if (err) return debug("error writitng file '%s': %s", destfile, err), fn(null);
					debug("written '%s'", destfile);
					
					// push to compression queue
					self.zqueue.push(destfile); 
					
					// cache
					if (!self.cache[u]) self.cache[u] = {};
					if (!self.cache[u].e) self.cache[u].e = []
					if (!!resp.headers["etag"]) self.cache[u].e.push(resp.headers["etag"]);
					while (self.cache[u].e.length > 5) self.cache[u].e.unshift();
					if (!!resp.headers["last-modified"]) self.cache[u].t = new Date(resp.headers["last-modified"]).valueOf();
					
					fn(null);
				});
			});
		});
	});
	
	return this;
};

// check and convert url to path
banish.prototype.urlpath = function(u, fn) {
	var self = this;
		
	var src = url.parse(self.cache.url);
	var dst = url.parse(u);
	
	if (src.host !== dst.host || src.protocol !== dst.protocol || src.auth !== dst.auth) return fn(null), this; // different origin
	var relpath = path.relative(src.pathname, dst.pathname);
	if (relpath.substr(0,3) === '../') return fn(null), this; // no subpath
	return fn (path.resolve(self.opts.dest, relpath)), this;
};

// make indexfile path for extensionless paths
banish.prototype.resolve = function(p, mime) {
	if (path.extname(p) !== "") return p;
	return path.resolve(p, "index."+(function(){
		switch (mime) {
			case "text/html": return 'html'; break;
			case "application/json": return 'json'; break;
			case "application/javascript": return 'js'; break;
			case "text/xml": return 'xml'; break;
			case "text/css": return 'text'; break;
			default: return 'html'; break;
		}
	})());
};

// remove resource from cache
banish.prototype.remove = function(u, p, fn){ 
	var self = this;

	rmrf(p, function(err){
		if (err) debug("error deleting '%s' from cache: %s", p, err);
		rmrf(p+".gz", function(err){
			if (err) debug("error deleting '%s.gz' from cache: %s", p, err);
			delete self.cache[u];
			fn(null);
		});
	});
	
	return this;
};

banish.prototype.compress = function(fn) {
	var self = this;
	
	var q = queue({ concurrency: 1 });
	
	self.zqueue.forEach(function(f){
		q.push(function(compressed){
			debug("[compressing] %s", f);
			fs.createReadStream(f).pipe(zopfli({})).pipe(fs.createWriteStream(f+".gz").on('finish', function(){
				debug("[compressed] %s", f);
				compressed();
			}));
		});
	});
	
	q.start(fn);
		
	return this;
};

module.exports = banish;