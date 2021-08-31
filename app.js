"use strict";
/*
TODO:
- reset button for each field, resets to last read value (bafang.data[blk][key])
- batch read/write, just iterate from BLK_BAS to BLK_THR
- use select instead of datalist input for fixed choice options?
- baud user setting and close button
- handle disconnects etc gracefully
*/
const BAUD_RATE = 1200;
// const BAUD_RATE = 9600;
const BLK_GEN = 0x51;
const BLK_BAS = 0x52;
const BLK_PAS = 0x53;
const BLK_THR = 0x54;
const CMD_READ = 0x11;
const CMD_WRITE = 0x16;
const blockNumBytes = {
        [BLK_GEN]: 19,
        [BLK_BAS]: 27,
        [BLK_PAS]: 14,
        [BLK_THR]: 9,
};
const blockKeys = {
        [BLK_GEN]: "info",
        [BLK_BAS]: "basic",
        [BLK_PAS]: "pedal",
        [BLK_THR]: "throttle",
};

class BafangConfig {
    constructor() {
        this.byteCount = 0;
        this.buffer = null;
        this.lastCmd = 0;
        this.data = {}; // NOTE: when reading file, skip "info" block, or compare with current info block!
        this.resultBlock = "";
        this.resultKey = "";
    }

    // callbacks
    onRead = function(blk) {};
    onWrite = function(blk,ok) {};
    onSerialConnect = function(port) {};
    
    parseGenData(buf) {
        let voltage = buf[16] > 4 ? "24V-60V" : ["24V","36V","48V","60V","24V-48V"][buf[16]];
        return {
            manufacturer:   String.fromCharCode.apply(null, buf.slice(2,2+4)),
            model:          String.fromCharCode.apply(null, buf.slice(6,6+4)),
            hw_ver:         String.fromCharCode.apply(null, buf.slice(10,12)).split("").join("."),
            fw_ver:         String.fromCharCode.apply(null, buf.slice(12,16)).split("").join("."),
            voltage:        voltage,
            max_current:    buf[17],
        };
    }
    speedModels = ["External","Internal","Motorphase"];
    parseBasData(buf) {
        let data = {
            low_battery_protect:    buf[2],
            current_limit:          buf[3],
            wheel_size:             buf[24]==0x37 ? "700C" : (Math.ceil(buf[24]/2) + '"'),
            speedmeter_model:       this.speedModels[buf[25] >> 6],
            speedmeter_signals:     buf[25] & 63,
        };
        for(i=0;i<10;i++) {
            data["assist"+i+"_current"] = buf[4+i];
            data["assist"+i+"_speed"] = buf[14+i];
        }
        return data;
    }
    makeBasData(data) {
        let buf = [
            data["low_battery_protect"],
            data["current_limit"],
        ];
        for(i=0;i<10;i++)
            buf.push(data["assist"+i+"_current"]);
        for(i=0;i<10;i++)
            buf.push(data["assist"+i+"_speed"]);
        buf.push(data["wheel_size"] == "700C" ? 0x37 : parseInt(data["wheel_size"])*2);
        let spd_sigs = data["speedmeter_signals"] & 63;
        let spd_model = Math.max(0,this.speedModels.indexOf(data["speedmeter_model"]));
        buf.push(spd_model << 6 | spd_sigs);
        return buf;
    }
    pedalTypes = ["None","DH-Sensor-12","BB-Sensor-32","DoubleSignal-24"];
    parsePasData(buf) {
        return {
            pedal_type:         this.pedalTypes[buf[2]],
            designated_assist:  buf[3]==0xff?"Display":buf[3],
            speed_limit:        buf[4]==0xff?"Display":buf[4],
            start_current:      buf[5],
            slow_start_mode:    buf[6],
            startup_degree:     buf[7],
            work_mode:          buf[8]==0xff?"Undetermined":buf[8],
            time_of_stop:       buf[9],
            current_decay:      buf[10],
            stop_decay:         buf[11],
            keep_current:       buf[12],
        };
    }
    makePasData(data) {
        return [
            Math.max(0,this.pedalTypes.indexOf(data["pedal_type"])),
            data["designated_assist"] == "Display" ? 0xff : data["designated_assist"],
            data["speed_limit"] == "Display" ? 0xff : data["speed_limit"],
            data["start_current"],
            data["slow_start_mode"],
            data["startup_degree"],
            data["work_mode"] == "Undetermined" ? 0xff : data["work_mode"],
            data["time_of_stop"],
            data["current_decay"],
            data["stop_decay"],
            data["keep_current"]
        ];
    }
    parseThrData(buf) {
        return {
            start_voltage:      buf[2],
            end_voltage:        buf[3],
            mode:               ["Speed","Current"][buf[4]],
            designated_assist:  buf[5]==0xff?"Display":buf[5],
            speed_limit:        buf[6]==0xff?"Display":buf[6],
            start_current:      buf[7],
        };
    }
    makeThrData(data) {
        return [
            data["start_voltage"],
            data["end_voltage"],
            data["mode"]=="Speed"?0:1,
            data["designated_assist"]=="Display"?0xff:data["designated_assist"],
            data["speed_limit"]=="Display"?0xff:data["speed_limit"],
            data["start_current"],
        ];
    }
    parseData(buf) {
        const blk = buf[0];
        console.log("Reading block:",blockKeys[blk]);
        switch(blk) {
            case BLK_GEN: return this.parseGenData(buf);
            case BLK_BAS: return this.parseBasData(buf);
            case BLK_PAS: return this.parsePasData(buf);
            case BLK_THR: return this.parseThrData(buf);
        }
        console.log("parseData: Unknown block",blk);
        return null;
    }
    
    parseBasCode(code) {
        let lvl=0;
        switch(code) {
            case 0: return ['Basic: Low Battery Protection out of range!', "low_battery_protect"];
            break;
            case 1: return ['Basic: Current Limit out of range!', "current_limit"];
            break;
            case 2: //0
            case 4: //1
            case 6: //2
            case 8: //3
            case 10: //4
            case 12: //5
            case 14: //6
            case 16: //7
            case 18: //8
            case 20: //9
                lvl = (code-2)/2;
                return ['Basic: Current Limit for Assist '+lvl+' out of range!',"assist"+lvl+"_current"];
            break;
            case 3:
            case 5:
            case 7:
            case 9:
            case 11:
            case 13:
            case 15:
            case 17:
            case 19:
            case 21:
                lvl = (code-3)/2;
                return ['Basic: Speed Limit for Assist '+lvl+' out of range!', "assist"+lvl+"_speed"];
            break;
            case 22: return ['Basic: Wheel Diameter out of range!', "wheel_size"];
            break;
            case 23: return ['Basic: Speed Meter Signals out of range!', "speedmeter_signals"];
            break;
            case 24: return null;
        }
        return ['Unknown result code: '+code,null];
    }
    parsePasCode(code) {
        switch(code) {
            case 0: return ['Pedal: Pedal Sensor Type error!', "pedal_type"];
            break;
            case 1: return ['Pedal: Designated Assist Level error!', "designated_assist"];
            break;
            case 2: return ['Pedal: Speed Limit error!', "speed_limit"];
            break;
            case 3: return ['Pedal: Current out of range!', "current_limit"];
            break;
            case 4: return ['Pedal: Slow-start Mode error!', "slow_start_mode"];
            break;
            case 5: return ['Pedal: Start Degree out of range!', "startup_degree"];
            break;
            case 6: return ['Pedal: Work Mode error!', "work_mode"];
            break;
            case 7: return ['Pedal: Time of Stop out of range!', "time_of_stop"];
            break;
            case 8: return ['Pedal: Current Decay out of range!', "current_decay"];
            break;
            case 9: return ['Pedal: Stop Decay out of range!', "stop_decay"];
            break;
            case 10: return ['Pedal: Keep Current out of range!', "keep_current"];
            break;
            case 11: return null;
        }
        return ['Unknown result code: '+code,null];
    }
    parseThrCode(code) {
        switch(code) {
            case 0: return ['Throttle: Start Voltage out of range!', "start_voltage"];
            break;
            case 1: return ['Throttle: End Voltage out of range!', "end_voltage"];
            break;
            case 2: return ['Throttle: Mode error!', "mode"];
            break;
            case 3: return ['Throttle: Designated Assist error!', "designated_assist"];
            break;
            case 4: return ['Throttle: Speed Limit error!', "speed_limit"];
            break;
            case 5: return ['Throttle: Start Current out of range!', "start_current"];
            break;
            case 6: return null;
        }
        return ['Unknown result code: '+code,null];
    }
    parseResultCode(buf) {
        const blk = buf[0];
        const code = buf[1];
        console.log("Write result for",blockKeys[blk],"=",code);
        this.resultBlock = blockKeys[blk];
        switch(blk) {
            case BLK_BAS: return this.parseBasCode(code);
            case BLK_PAS: return this.parsePasCode(code);
            case BLK_THR: return this.parseThrCode(code);
        }
        console.log("parseResultCode: Unknown block",blk);
        return null;
    }
    prepareWriteData(blk, buf) {
        let data = [CMD_WRITE, blk, buf.length];
        data = data.concat(buf);
        this.addVerification(data);
        console.log("Prepare to write:",data);
        return data;
    }
    bytesForBlock(blk) {
        let key = blockKeys[blk];
        let buf = null;
        switch(blk) {
            case BLK_BAS: buf = this.makeBasData(this.data[key]);
            break;
            case BLK_PAS: buf = this.makePasData(this.data[key]);
            break;
            case BLK_THR: buf = this.makeThrData(this.data[key]);
            break;
            default:
                console.log("bytesForBlock: Unknown block",blk);
                return null;
        }
        return buf.map((e)=>{return parseInt(e)});
    }
    async writeBlock(blk) {
        this.parseTable(blockKeys[blk]);
        let data = this.bytesForBlock(blk);
        data = this.prepareWriteData(blk, data);
        this.expectBytes(2, CMD_WRITE);
        return this.write(data);
    }
    processResponse(buf) {
        const blk = buf[0];
        const key = blockKeys[blk];
        if(!key) {
            this.logError(BLK_GEN, "Unexpected block in response, ignoring");
        } else if(this.lastCmd == CMD_READ) {
            this.data[key] = this.parseData(buf);
            this.onRead(blk);
            this.logMsg(blk, "Read successful");
            
            // Verify that our byte generation code works.
            // Note this can fail on wheelsize since two values equals the same size..
            /*let org = buf.slice(2,-1);
            let xxx = this.bytesForBlock(blk);
            if(xxx.length === org.length && org.every((v,i) => v===xxx[i])) {
                console.log("Internal byte generation check successful");
            } else {
                console.log("Internal byte generation check failed!");
                console.log("READ",org);
                console.log("WRITE",xxx);
            }*/
        } else if(this.lastCmd == CMD_WRITE) {
            const res = this.parseResultCode(buf);
            if(!res) {
                this.logMsg(blk, "Write successful");
                this.onWrite(blk, null);
            } else {
                this.logError(blk, res[0]);
                this.onWrite(blk, res[1]);
            }
        }
    }
    async listen() {
        const reader = this.reader;

        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                reader.releaseLock();
                console.log("DONE");
                break;
            }
            console.log("read "+value);

            /*
            // DUMMY TEST WITH LOOP BACK DEVICE
            if(this.byteCount > 0 && this.buffer) {
                this.byteCount = 0;
                // GEN
                //this.buffer = [0x51,0x10,0x48,0x5A,0x58,0x54,0x53,0x5A,0x5A,0x36,0x32,0x32,0x32,0x30,0x31,0x31,0x01,0x14,0x1B];
                // BAS
                if(this.lastCmd == CMD_READ)
                    this.buffer = [0x52, 0x18, 0x1F, 0x0F, 0x00, 0x1C, 0x25, 0x2E, 0x37, 0x40, 0x49, 0x52, 0x5B, 0x64, 0x64, 0x64, 0x64, 0x64, 0x64, 0x64, 0x64, 0x64, 0x64, 0x64, 0x35, 0x42, 0xDF];
                else
                    this.buffer = [0x52, 50];
                // PAS
                // this.buffer = [0x53, 0x0B, 0x03, 0xFF, 0xFF, 0x64, 0x06, 0x14, 0x0A, 0x19, 0x08, 0x14, 0x14, 0x27];
                // THR
                // this.buffer = [0x54, 0x06, 0x0B, 0x23, 0x00, 0x03, 0x11, 0x14, 0xAC];
                
                this.processResponse(this.buffer);
            }
            */
            
            for (const a of value) {    
                if(this.byteCount > 0 && this.buffer) {
                    this.byteCount--;
                    console.log("pushing 0x"+a.toString(16)+", "+this.byteCount+" bytes left");
                    this.buffer.push(a);
                    if(this.byteCount == 0) {
                        console.log("Got all "+this.buffer.length+" bytes");
                        this.processResponse(this.buffer);
                    }
                } else {
                    console.log("ignoring byte: 0x"+a.toString(16));
                }
            }
        }
    }
    logError(blk, ...msg) {
        const node = document.querySelector('#'+blockKeys[blk]+'.error-display');
        node.style.color = "red";
        node.innerText = msg.join(' ');
        console.log("ERROR:",msg.join(' '));
    }
    logMsg(blk, ...msg) {
        const node = document.querySelector('#'+blockKeys[blk]+'.error-display');
        node.style.color = "green";
        node.innerText = msg.join(' ');
        console.log("LOG:",msg.join(' '));
    }
    async init() {
        if ('serial' in navigator) {
            try {
                const port = await navigator.serial.requestPort();
                console.log(port);
                await port.open({ baudRate: BAUD_RATE });
                this.reader = port.readable.getReader();
                this.writer = port.writable.getWriter();
                /*let signals = await port.getSignals();*/

                this.listen();
                this.onSerialConnect(port);
            }
            catch (err) {
                console.log(err);
                if(err.name != "NotFoundError")
                    this.logError(BLK_GEN,'Could not open serial port:',err);
            }
        }
        else {
            console.error('Web serial doesn\'t seem to be enabled in your browser. Try enabling it by visiting:');
            console.error('chrome://flags/#enable-experimental-web-platform-features');
            console.error('opera://flags/#enable-experimental-web-platform-features');
            console.error('edge://flags/#enable-experimental-web-platform-features');
        }
    }
    async write(data) {
        return await this.writer.write(Uint8Array.from(data));
    }
    verificationByte(data) {
        let x = data.slice(1).reduce((tot,val) => {
            return tot + val;
        });
        return (x % 256);
    }
    addVerification(data) {
        data.push(this.verificationByte(data));
    }
    expectBytes(len, cmd) {
        console.log("expecting "+len+" bytes...");
        if(this.byteCount > 0)
            this.logError("Warning: Previous read not finished");
        this.lastCmd = cmd;
        this.byteCount = len;
        this.buffer = new Array();
    }
    async connectDevice() {
        let data = [CMD_READ, BLK_GEN, 4, 0xb0];
        this.addVerification(data);
        // console.log(data);
        this.expectBytes(blockNumBytes[BLK_GEN], CMD_READ);
        // await new Promise(r => setTimeout(r, 3000)); // test
        return this.write(data);
    }
    async readBlock(blk) {
        let data = [CMD_READ, blk];
        this.logMsg(blk,"Waiting for response...");
        this.expectBytes(blockNumBytes[blk], CMD_READ);
        return this.write(data);
    }
    readFile(f) {
        let fr = new FileReader();
        fr.onload = (e) => {
            let oldInfo = this.data["info"];
            this.data = JSON.parse(e.target.result);
            if(oldInfo) this.data["info"] = oldInfo;
            this.onRead(null);
        };

        fr.readAsText(f);
    }
    timestamp() {
        let d = new Date();
        return d.getFullYear() + "-"
            + ("0"+(d.getMonth()+1)).slice(-2) + "-"
            + ("0" + d.getDate()).slice(-2) + "_"
            + ("0" + d.getHours()).slice(-2) + "-"
            + ("0" + d.getMinutes()).slice(-2) + "-"
            + ("0" + d.getSeconds()).slice(-2);
    }
    saveFile() {
        for (let blk of [BLK_BAS, BLK_PAS, BLK_THR])
            this.parseTable(blockKeys[blk]);
        //console.log(JSON.stringify(this.data, null, 2));
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([JSON.stringify(this.data, null, 2)], {
            type: "application/json"
        }));
        let now = new Date();
        a.setAttribute("download", "bafang_profile_"+this.timestamp()+".json"); // TODO append date
        //a.setAttribute("target", "_blank"); // this had no SaveAs enabled in chrome
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
}
