(function(root){'use strict';
// Display only. Never use this cyclic number as a database key or request ID.
function cafeNumber(id){if(!Number.isSafeInteger(id)||id<1)throw new RangeError('Invalid internal cafe order ID');return String((id-1)%999+1).padStart(3,'0');}
if(typeof module==='object'&&module.exports)module.exports=cafeNumber;else root.STARTCafeNumber=cafeNumber;
})(globalThis);
