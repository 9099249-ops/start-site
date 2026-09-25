import {parentPort,workerData} from 'node:worker_threads';
import {AdminStore} from '../admin.mjs';
import {PrintStore} from '../print.mjs';
const admin=new AdminStore(workerData.file);
try{const store=new PrintStore(admin,{env:workerData.env});parentPort.postMessage(store.report({},{id:1,role:'admin'},workerData.now).job.id);}finally{admin.close();}
