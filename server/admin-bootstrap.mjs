import {AdminStore} from './admin.mjs';
let token='';for await(const chunk of process.stdin)token+=chunk;
token=token.trim();if(!/^[a-f0-9]{64}$/.test(token))throw Error('Invalid setup token format');
const store=new AdminStore(process.env.BOOKING_DB);
try{store.setupToken(token);console.log('One-time setup code registered; no user accounts created yet.');}finally{store.close();}
