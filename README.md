# scratch-node-link
使用 nodejs 模拟 scratch-link 实现硬件连接通讯

### 使用方法
```bash
git clone https://github.com/Micircle/scratch-node-link.git
npm i
npm start
```
将 ```scratch-gui/node_modules/scratch-vm/src/util/scratch-link-websocket.js``` 中

```javascript
this._ws = new WebSocket('wss://device-manager.scratch.mit.edu:20110/scratch/ble');
```
改为
```javascript
this._ws = new WebSocket('ws://127.0.0.1:20110/scratch/ble');
```
就可以连接 microbit 了

Windows 如果 npm 安装依赖失败，请查看：https://github.com/noble/noble 的说明