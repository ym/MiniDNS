module.exports = function(self) {
	if(!self._GeoIP)
	 	self.initGeoIP();

	return function(record, addr) {

		switch(record.argument) {
			case 'misc/time':
				if(record.type !== 16)
					record.nxdomain = true;
				else
					record.data = String(new Date());
				break;
			case 'misc/timestamp':
				if(record.type !== 16)
					record.nxdomain = true;
				else
					record.data = String(Date.now());
				break;
			case 'misc/source':
				record.address = addr.address;
				break;
			case 'geoip/asn':
				record.data = JSON.stringify(self.GeoIP('asn', addr.address));
				break;
			case 'geoip/country':
				record.data = JSON.stringify(self.GeoIP('country', addr.address));
				break;
			case 'geoip/city':
				record.data = JSON.stringify(self.GeoIP('city', addr.address));
				break;
			default:
				record.nxdomain = true;
				break;
		}

		return record;
	}
}