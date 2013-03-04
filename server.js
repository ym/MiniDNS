var dns = require('native-dns'),
	color = require('colors'),
	geoip = require('geoip'),
	async = require('async'),
	fs = require('fs');

var cluster = require('cluster');

var _dispatcher = function() {
	var _data = {}, _zones = {}, _willcards = {}, _handlers = {};

	var _cacheZone = {}, _cachedWillcard = {};

	var self = this;

	var _init = function() {

		_loadHandler('toolkit');

		fs.readdir('data/zones', function (err, files) {
			async.series((function (files) {
				var task = function(zone) {
					return function(callback) {
						_loadZone(zone);
						callback(null, true);
					}
				} , tasks = [task('swaname.net')];

				for (var i = files.length - 1; i >= 0; i--)
					if(files[i] !== 'swaname.net')
						tasks.push(task(files[i]));

				return tasks;
			})(files));
		});

	} , _loadHandler = function(name) {

		// clear cache if exists ...

		if(_handlers[name])
			delete require.cache[require.resolve('./handlers/' + name)];

		try {
			_handlers[name] = require('./handlers/' + name)(self);
		} catch(e) {

			console.log('Failed to load smart record handler '.red + name.white);

			return false;
		}

		console.log('Loaded Smart Record Handler '.green + name.white);

		return true;

	} , _loadZone = function(name) {
		fs.readFile('./data/zones/' + name, 'utf8', function(err, data){
			if (err) {
				return console.log('Failed to load zone '.red + name.white);
			}

			try {
				var zone = JSON.parse(data);
			} catch(e) {
				return console.log('Failed to parse zone '.red + name.white);
			}

			// append parent record
			if(!_cacheZone[name])
				_cacheZone[name] = name;

			// clear zone data if exists ...

			if(_zones[name]) {

				for(var record in _zones[name].smartrecords)
					if(!zone.smartrecords[record]) {
						delete _cacheZone[record + '.' + name];

						if(record.indexOf('*') == 0) {
							console.log('Deleted willcard record '.green + (record + '.' + name).white);

							delete _willcards[record];
						}
					}

				for(var record in _zones[name].records)
					if(!zone.records[record]) {
						delete _cacheZone[record + '.' + name];

						if(record.indexOf('*') == 0) {
							console.log('Deleted willcard record '.green + (record + '.' + name).white);

							delete _willcards[record];
						}
					}

			}

			// made nameservers data friendly

			for (var i = 0; i < zone.nameservers.length; i++)
				zone.nameservers[i] = dns.NS({
					name: name,
					data: zone.nameservers[i],
					ttl: zone.soa.ttl,
				});

			// cache all records into memory ...

			var processRecords = function (record) {
				return function(item) {
					if(!item.ttl)
						item.ttl = zone.soa.ttl;

					item.name = record == '@' ? name : record + '.' + name;

					if(record.indexOf('*') == 0) {
						_willcards[record] = [new RegExp(item.name.replace("*", "(.*)") + '$'), record, name];

						console.log('Added willcard record '.green + item.name.white);
					}

					item = dns[item.type](item);

					return item;
				}
			};
			
			for(var record in zone.records) 
				zone.records[record] = zone.records[record].map(processRecords(record));
			
			for(var record in zone.smartrecords) 
				zone.smartrecords[record] = zone.smartrecords[record].map(processRecords(record));

			// cache zone records ...
			
			for(var record in zone.smartrecords)
				_cacheZone[record + '.' + name] = name;
			
			for(var record in zone.records)
				_cacheZone[record + '.' + name] = name;

			// generate SOA record ...
			zone.nameservers.unshift(dns.SOA({
				primary: zone.soa.primary,
				admin: zone.soa.email.replace('@', '.'),
				serial: parseInt(zone.soa.id),
				refresh: parseInt(zone.soa.refresh),
				retry: parseInt(zone.soa.retry),
				expiration: parseInt(zone.soa.expire),
				minimum: 300,
				ttl: parseInt(zone.soa.ttl),
				name: name
			}));

			// write to zone config ...

			_zones[name] = zone;

			// additional records ...

			zone.additional = _handleNameserverAdditional(zone.nameservers);

			delete zone;

			console.log('Loaded Zone '.green + name.white);
		});
	} , _handleNameserverAdditional = function(items) {
		var ret = [];

		for (var i = items.length - 1; i >= 0; i--) {


			if(!_cacheZone[items[i].data])
				continue;

			var sub = items[i].data.substr(0, items[i].data.length - _cacheZone[items[i].data].length - 1);

			if(_zones[_cacheZone[items[i].data]].records[sub])
				_zones[_cacheZone[items[i].data]].records[sub].forEach(function(item) {
					ret.unshift(item);
				});

		}

		return ret;

	} , _handleSmartRecord = function(addr) {

		return function(item) {
			if(item.handler && item.argument) {
				switch(item.handler) {
					case 'toolkit':
						item = _handlers.toolkit(item, addr);
						break;
					case 'geoip':
						item = _handlers.geoip(item, addr);
						break;
					case 'sinaip':
						item = _handlers.sinaip(item, addr);
						break;
					default:
						item.nxdomain = true;
						break;
				}
			}
			return item;
		}
	} , _handleAdminRequest = function(req, res) {

		if(req.question[0].type !== 16)
			return res.send();

		var cmd = req.question[0].name.substr(0, req.question[0].name.lastIndexOf('.path53-admin')).split('.');

		res.answer = [dns.TXT({
			name: 'success',
			data: 'true',
			ttl: 1
		})];

		switch(cmd[cmd.length - 1]) {
			case 'list-handlers':
				for(var handler in _handlers)
					res.answer.push(dns.TXT({
						name: 'handlers',
						data: handler,
						ttl: 1
					}));
				break;
			case 'load-handler':
				for (var i = 0; i < cmd.length - 1; i++)
					res.answer.push(dns.TXT({
						name: 'load-handler-' + cmd[i],
						data: _loadHandler(cmd[i]) ? 'true' : 'false',
						ttl: 1
					}));
				break;
			case 'load-zone':
				for (var i = 0; i < cmd.length - 1; i++) {
					_loadZone(cmd[i].replace(/\-/g, '.'));
					res.answer.push(dns.TXT({
						name: 'load-zone-' + cmd[i].replace(/\-/g, '.'),
						data: 'true',
						ttl: 1
					}));
				}
				break;
			case 'init-geoip':
				self.initGeoIP();
				break;
			default:
				res.answer[0].data = 'false';
				res.answer.push(dns.TXT({
					name: 'errmsg',
					data: 'Invalid command',
					ttl: 1
				}));
				break;
		}

		res.send();

		console.log('Recevied admin request from '.grey + req.address.address.white);

	}

	this.initGeoIP = function() {
		if(!self._GeoIP)
			self._GeoIP = {};

		fs.readdir('data/geoip', function (err, files) {
			files.forEach(function(file) {
				try {
					var edition = geoip.check('data/geoip/' + file);
				} catch(e) {
					return ;
				}

				switch(edition) {
					case 'country':
						self._GeoIP.country = (new geoip.Country('data/geoip/' + file));
						break;
					case 'city':
						self._GeoIP.city = (new geoip.City('data/geoip/' + file));
						break;
					case 'asnum':
						self._GeoIP.asn = (new geoip.Org('data/geoip/' + file));
						break;
					default:
						return;
				}

				console.log('Found GeoIP Database '.green + edition.white + ' and loaded into memory'.green);
			});
		});
	}

	this.GeoIP = function(type, addr) {
		if(!self._GeoIP || !self._GeoIP[type])
			return null;

		return self._GeoIP[type].lookupSync(addr);
	}

	this.onRequest = function(req, res) {

		// invalid request, return directly ... 

		if(req.question.length == 0 || req.question[0].name == '')
			return res.send();

		// administratorative functions ...

		if( req.question[0].name.indexOf('.path53-admin')
			&& req.question[0].name.substr(req.question[0].name.lastIndexOf('.path53-admin')) == '.path53-admin')
				return _handleAdminRequest(req, res);

		// if record not exists ... then try willcards

		var willcard = false;

		if(!_cacheZone[req.question[0].name]) {
			for (var record in _willcards) {
				willcard = req.question[0].name.match(_willcards[record][0]);

				if(willcard)
					willcard = [record, _willcards[record][1], _willcards[record][2]];
					break;
			}

			// send directly ...
			if(!willcard)
				return req.send();

		}

		if(willcard) {
			var fqdn = req.question[0].name
			  , name = willcard[2]
			  , zone = _zones[name]
			  , record = willcard[1];

		} else {
			var fqdn = req.question[0].name
			  , name = _cacheZone[fqdn]
			  , zone = _zones[name]
			  , record = fqdn.substr(0,
			  		fqdn.length -
			  		name.length -
			  		1);
		}

		// naked domain ...
		if(!record)
			record = '@';

		// authority section ...
		res.authority = zone.nameservers;

		res.additional = zone.additional;

		// lookup record ...

		var smart = false;

		if(zone.records[record])
			res.answer = zone.records[record].slice(0);
		else if(zone.smartrecords[record]) {
			res.answer = zone.smartrecords[record].slice(0);
			smart = true;
		}

		// filter record ...

		for (var i = 0; i < res.answer.length; i++)
			if(req.question[0].type !== res.answer[i].type)
				res.answer.splice(i, 1);

		// if smart record

		if(smart && res.answer.length > 0) {

			res.answer = res.answer.map(_handleSmartRecord(req.address));

			for (var i = res.answer.length - 1; i >= 0; i--) {
				if(res.answer[i].next)
					delete res.answer[i].next;

				if(res.answer[i].nxdomain) {
					res.answer = [];
					break;
				}
			}
		}

		// if willcard
		if(willcard)
			for (var i = res.answer.length - 1; i >= 0; i--)
				res.answer[i].name = fqdn;

		// cleanup

		delete fqdn, name, zone, record, smart, willcard;

		res.send();
	}

	_init();
}

var _cores = require('os').cpus().length;

var _createService = function() {
	var udpDNSServer = dns.createUDPServer(),
	tcpDNSServer = dns.createTCPServer();

	var dispatcher = new _dispatcher();

	udpDNSServer.on('listening', function() {
		console.log('UDP DNS Server listening on '.green + (this._socket.type + '://0.0.0.0').white);
	});

	udpDNSServer.on('request', dispatcher.onRequest);
	// udpDNSServer.on('error', _onError);

	tcpDNSServer.on('request', dispatcher.onRequest);
	// tcpDNSServer.on('error', _onError);

	tcpDNSServer.on('listening', function() {
		console.log('TCP DNS Server listening on '.green + 'tcp://0.0.0.0'.white);
	});

	udpDNSServer.serve(53);
	tcpDNSServer.serve(53);


}

if(_cores == 1) {
	console.log('Detected only one core, will work as single process.'.cyan);

	_createService();
} else {
	console.log(('Detected ' + _cores + ' cores, will work as a cluster.').green);

	if(cluster.isMaster) {
		console.log('Forking ...'.green);

		for (var i = 0; i < _cores; i++)
    		cluster.fork();
	} else {
		_createService();
	}
}

