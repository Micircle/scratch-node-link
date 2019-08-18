const noble = require('noble-mac');
const Session = require('./session');

const getUUID = id => {
    if (typeof id === 'number') return id.toString(16);
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
        return id.split('-').join('');
    }
    return id;
};

class BLESession extends Session {
    constructor (socket) {
        super(socket);
        this._type = 'ble';
        this.peripheral = null;
        this.services = null;
        this.characteristics = {};
        this.notifyCharacteristics = {};
        this.scanningTimeId = null;
        this.reportedPeripherals = {};
        this.discoverListener = null;
    }

    async didReceiveCall (method, params, completion) {
        switch (method) {
            case 'discover':
                this.discover(params);
                completion(null, null);
                break;
            case 'connect':
                await this.connect(params);
                completion(null, null);
                break;
            case 'disconnect':
                await this.disconnect(params);
                completion(null, null);
                break;
            case 'write':
                completion(await this.write(params), null);
                this.repairNotifyAfterWrite();
                break;
            case 'read':
                completion(await this.read(params), null);
            case 'startNotifications':
                await this.startNotifications(params);
                completion(null, null);
                break;
            case 'stopNotifications':
                await this.stopNotifications(params);
                completion(null, null);
                break;
            case 'getServices':
                completion((this.services || []).map(service => service.uuid), null);
                break;
            case 'pingMe':
                completion('willPing', null);
                this.sendRemoteRequest('ping', null, (result, error) => {
                    console.log(`Got result from ping: ${result}`);
                });
                break;
            default:
                throw new Error(`Method not found`);
        }
    }

    discover (params) {
        if (this.services) {
            throw new Error('cannot discover when connected');
        }
        const {filters} = params;
        // if (!Array.isArray(filters) || filters.length < 1) {
        //     throw new Error('discovery request must include filters');
        // }
        // filters.forEach(item => {
        //     const {services} = item;
        //     if (!Array.isArray(services) || services.length < 1) {
        //         throw new Error(`filter contains empty or invalid services list: ${item}`);
        //     }
        // });
        if (this.scanningTimeId) {
            clearTimeout(this.scanningTimeId);
        }
        this.reportedPeripherals = {};
        noble.startScanning([], true);
        this.discoverListener = peripheral => {
            this.onAdvertisementReceived(peripheral, filters);
        };
        noble.on('discover', this.discoverListener);
    }

    onAdvertisementReceived (peripheral, filters) {
        const {advertisement} = peripheral;
        if (advertisement) {
            const finded = (filters || []).find(filter => {
                const {name, namePrefix, services, manufacturerData} = filter;
                if (name && name !== advertisement.localName) return false;
                if (namePrefix && advertisement.localName.indexOf(namePrefix) !== 0) return false;
                if (services && !services.every(service => {
                    if (!advertisement.serviceUuids) return false;
                    return advertisement.serviceUuids.indexOf(getUUID(service)) !== -1;
                })) return false;
                if (manufacturerData && advertisement.manufacturerData) {
                    if (manufacturerData.length !== advertisement.manufacturerData.length) {
                        return false
                    }
                    if (!manufacturerData.every((data, i) => dvertisement.manufacturerData[i] === data)) {
                        return false;
                    }
                }
                return !!advertisement.localName;
            });
            if (finded) {
                this.reportedPeripherals[peripheral.id] = peripheral;
                this.sendRemoteRequest('didDiscoverPeripheral', {
                    peripheralId: peripheral.id,
                    name: advertisement.localName,
                    rssi: peripheral.rssi
                });
                if (!this.scanningTimeId) {
                    this.scanningTimeId = setTimeout(() => {
                        this.scanningTimeId = null;
                        noble.stopScanning();
                        if (this.discoverListener) {
                            noble.removeListener('discover', this.discoverListener);
                        }
                    }, 1000);
                }
            }
        }
    }

    connect (params) {
        return new Promise((resolve, reject) => {
            if (this.peripheral && this.peripheral.state === 'connected') {
                return reject(new Error('already connected to peripheral'));
            }
            const {peripheralId} = params;
            const peripheral = this.reportedPeripherals[peripheralId];
            if (!peripheral) {
                return reject(new Error(`invalid peripheral ID: ${peripheralId}`));
            }
            if (this.scanningTimeId) {
                clearTimeout(this.scanningTimeId);
                this.scanningTimeId = null;
                noble.stopScanning();
            }
            try {
                peripheral.connect(error => {
                    if (error) {
                        return reject(new Error(error));
                    }
                    peripheral.discoverAllServicesAndCharacteristics((err, services) => {
                        if (err) {
                            return reject(new Error(error));
                        }
                        this.services = services;
                        this.peripheral = peripheral;
                        resolve();
                    });
                });
                peripheral.on('disconnect', (err) => {
                    this.disconnect();
                });
            } catch (err) {
                reject(err);
            }
        })
    }

    bleWriteData (characteristic, withResponse, data) {
        return new Promise((resolve, reject) => {
            characteristic.write(data, !withResponse, (err) => {
                if (err) return reject(err);
                resolve();
            });
        })
    }

    async write (params) {
        try {
            const {message, encoding, withResponse} = params;
            const buffer = new Buffer(message, encoding);
            const characteristic = await this.getEndpoint('write request', params, 'write');
            for (let i = 0; i < buffer.length; i += 20) {
                await this.bleWriteData(characteristic, withResponse, buffer.slice(i, 20));
            }
            return buffer.length;
        } catch (err) {
            return new Error(`Error while attempting to write: ${err.message}`);
        }
    }

    bleReadData (characteristic, encoding = 'base64') {
        return new Promise((resolve, reject) => {
            characteristic.read((err, data) => {
                if (err) {
                    return reject(err);
                }
                resolve(data.toString(encoding));
            });
        });
    }

    async read (params) {
        try {
            const characteristic = await this.getEndpoint('read request', params, 'read');
            const readedData = await this.bleReadData(characteristic);
            const {startNotifications} = params;
            if (startNotifications) {
                await this.startNotifications(params, characteristic);
            }
            return readedData;
        } catch (err) {
            console.log('Error while attempting to read: ', err);
            return new Error(`Error while attempting to read: ${err.message}`);
        }
    }

    async startNotifications (params, characteristic) {
        let uuid;
        if (!characteristic || characteristic.properties.indexOf('notify') === -1) {
            characteristic = await this.getEndpoint('startNotifications request', params, 'notify');
        }
        uuid = getUUID(characteristic.uuid);
        if (!this.notifyCharacteristics[uuid]) {
            this.notifyCharacteristics[uuid] = characteristic;
            characteristic.subscribe();
        }
        if (!characteristic._events || !characteristic._events['data']) {
            characteristic.on('data', (data) => {
                this.onValueChanged(characteristic, data);
            });
        }
    }

    async stopNotifications (params) {
        console.log('stopNotifications !!!')
        const characteristic = await this.getEndpoint('stopNotifications request', params, 'notify');
        characteristic.unsubscribe();
        characteristic.removeAllListeners('data');
        delete this.notifyCharacteristics[getUUID(characteristic.uuid)];
    }

    notify (characteristic, notify) {
        return new Promise((resolve, reject) => {
            characteristic.notify(notify, err => {
                if (err) return reject(err);
                resolve();
            })
        })
    }

    // noble bug: 当 write 之后, characteristic 对象会发生变化
    repairNotifyAfterWrite () {
        for (const id in this.notifyCharacteristics) {
            const characteristic = this.notifyCharacteristics[id];
            const {_peripheralId, _serviceUuid, uuid} = characteristic;
            const currentCharacteristic = noble._characteristics[_peripheralId][_serviceUuid][uuid];
            if (characteristic !== currentCharacteristic) {
                currentCharacteristic._events = characteristic._events;
                this.notifyCharacteristics[id] = currentCharacteristic;
            }
        }
    }

    async stopAllNotifications () {
        for (const id in this.notifyCharacteristics) {
            await this.notify(this.notifyCharacteristics[id], false);
            this.notifyCharacteristics[id].removeAllListeners('data');
        }
    }

    onValueChanged (characteristic, data) {
        const params = {
            serviceId: characteristic._serviceUuid,
            characteristicId: characteristic.uuid,
            encoding: 'base64',
            message: data.toString('base64')
        };
        this.sendRemoteRequest('characteristicDidChange', params);
    }

    getEndpoint (errorText, params, type) {
        return new Promise((resolve, reject) => {
            if (!this.peripheral || this.peripheral.state !== 'connected') {
                return reject(`Peripheral is not connected for ${errorText}`);
            }
            let service;
            let {serviceId, characteristicId} = params;
            characteristicId = getUUID(characteristicId);
            if (this.characteristics[characteristicId]) {
                return resolve(this.characteristics[characteristicId]);
            }
            if (serviceId) {
                serviceId = getUUID(serviceId);
                service = this.services.find(item => item.uuid === serviceId);
            } else {
                service = this.services[0];
                serviceUuid = service.uuid;
            }
            if (!service) {
                reject(`Could not determine service UUID for ${errorText}`);
            }
            service.discoverCharacteristics([characteristicId], (err, characteristics) => {
                if (err) {
                    console.warn(err);
                    return reject(`could not find characteristic ${characteristicId} on service ${serviceUuid}`);
                }
                const characteristic = characteristics.find(item => item.properties.includes(type));
                if (characteristic) {
                    this.characteristics[characteristicId] = characteristic;
                    resolve(characteristic);
                } else {
                    reject(`failed to collect ${type} characteristic from service`);
                }
            });
        });
    }

    disconnect () {
        if (this.peripheral && this.peripheral.state === 'connected') {
            this.peripheral.disconnect();
        }
    }

    dispose () {
        this.disconnect();
        super.dispose();
        this.stopAllNotifications();
        this.socket = null;
        this.peripheral = null;
        this.services = null;
        this.characteristics = null;
        this.scanningTimeId = null;
        this.reportedPeripherals = null;
        this.notifyCharacteristics = null;
        if (this.discoverListener) {
            noble.removeListener('discover', this.discoverListener);
            this.discoverListener = null;
        }
    }
}

module.exports = BLESession;