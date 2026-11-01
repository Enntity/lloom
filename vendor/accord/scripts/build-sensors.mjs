// SPDX-License-Identifier: MIT
import { buildSensors,bundledSensors } from '../src/native-sensors.mjs';
const result=buildSensors({output:bundledSensors,force:true});console.log(JSON.stringify(result));
if(process.platform==='darwin'&&result.status!=='available')process.exitCode=1;
