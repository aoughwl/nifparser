// Canonical JS runtime for the Leng JS backend: one ArrayBuffer as linear memory,
// plus the small set of C primitives the lowered code imports. The heap is Nim's
// OWN native allocator (`-d:nimNativeAlloc` — the ported `system/alloc.nim`),
// compiled to JS through lengjs like any other module; the runtime provides only
// `mmap`/`munmap` as the page primitives it sits on (Araq's boundary), so `alloc`/
// `dealloc`/`realloc` and their free-list reuse all run as real Nim code.
const _ab = (globalThis.__leng_ab || (globalThis.__leng_ab = new ArrayBuffer(1 << 28)));           // 256 MiB linear memory (raised from 1<<26: the bump allocator has no GC, so large allocating loops / big output exhausted 64 MiB and threw "Offset is outside the bounds of the DataView")
const _dv = (globalThis.__leng_dv || (globalThis.__leng_dv = new DataView(_ab)));
const _u8 = (globalThis.__leng_u8 || (globalThis.__leng_u8 = new Uint8Array(_ab)));
let _brk = 8;                                   // offset 0 reserved as nil

// `allocFixed(n)` is the codegen's own storage for value aggregates (a C-stack
// model: never freed), distinct from the Nim heap that sits on `mmap` below.
function allocFixed(n){ const p=(_brk+7)&~7; _brk=p+n; _u8.fill(0,p,p+n); return p; }

// Page primitives for `system/osalloc.nim`: `mmap` hands the Nim allocator a
// page-aligned, zero-filled region carved from the same buffer (MAP_FAILED = -1
// on exhaustion, which makes the allocator raise OutOfMem); `munmap` is a no-op
// (the bump arena does not reclaim whole pages — the Nim allocator still reuses
// cells within them). Signature matches posix `mmap(adr,len,prot,flags,fd,off)`.
const _PAGE = 4096;
function mmap(adr, len, prot, flags, fildes, off){
  len = Number(len);
  const p = (_brk + _PAGE - 1) & ~(_PAGE - 1);  // page-align
  if (p + len > _u8.length) return -1;          // MAP_FAILED
  _brk = p + len;
  _u8.fill(0, p, p + len);                      // MAP_ANONYMOUS: zero-filled
  return p;
}
function munmap(adr, len){ return 0; }

const mem = {
  setI8:(p,v)=>_dv.setInt8(p,v), i8:(p)=>_dv.getInt8(p),
  setU8:(p,v)=>_dv.setUint8(p,v), u8At:(p)=>_dv.getUint8(p),
  setI16:(p,v)=>_dv.setInt16(p,v,true), i16:(p)=>_dv.getInt16(p,true),
  setU16:(p,v)=>_dv.setUint16(p,v,true), u16:(p)=>_dv.getUint16(p,true),
  setI32:(p,v)=>_dv.setInt32(p,v,true), i32:(p)=>_dv.getInt32(p,true),
  setU32:(p,v)=>_dv.setUint32(p,v,true), u32:(p)=>_dv.getUint32(p,true),
  setI64:(p,v)=>_dv.setBigInt64(p,BigInt(v),true), i64n:(p)=>Number(_dv.getBigInt64(p,true)),
  setU64:(p,v)=>_dv.setBigUint64(p,BigInt(v),true), u64n:(p)=>Number(_dv.getBigUint64(p,true)),
  i64b:(p)=>_dv.getBigInt64(p,true), u64b:(p)=>_dv.getBigUint64(p,true),   // exact 64-bit reads (int64/uint64 -> BigInt)
  setF64:(p,v)=>_dv.setFloat64(p,v,true), f64:(p)=>_dv.getFloat64(p,true),
  copy:(d,s,n)=>_u8.copyWithin(d,s,s+n),
  bytes:(p,n)=>_u8.subarray(p,p+n),
  writeStr:(p,s)=>{ for(let i=0;i<s.length;i++) _u8[p+i]=s.charCodeAt(i); },
};

function memcpy(d,s,n){ _u8.copyWithin(Number(d),Number(s),Number(s)+Number(n)); return d; }
function memset(p,v,n){ _u8.fill(v&0xff,Number(p),Number(p)+Number(n)); return p; }
function strlen(p){ let n=0; while(_u8[Number(p)+n]!==0) n++; return n; }
function memcmp(a,b,n){ a=Number(a);b=Number(b);n=Number(n); for(let i=0;i<n;i++){ const d=_u8[a+i]-_u8[b+i]; if(d!==0) return d<0?-1:1; } return 0; }

// GCC/Clang 64-bit bit intrinsics `importc`'d by the stdlib's SWAR string
// comparison (system/stringimpl.nim: ctz/clz/bswap over a uint64 word). The
// codegen calls them by their C names on BigInt args; ctz/clz return an int.
// (C leaves ctz/clz of 0 undefined; the callers never pass 0, but returning 64
// is the well-defined choice.)
function __builtin_ctzll(x){ x=BigInt.asUintN(64,BigInt(x)); if(x===0n) return 64; let n=0; while((x&1n)===0n){ x>>=1n; n++; } return n; }
function __builtin_clzll(x){ x=BigInt.asUintN(64,BigInt(x)); if(x===0n) return 64; let n=0; for(let i=63n;i>=0n;i--){ if((x>>i)&1n) break; n++; } return n; }
function __builtin_bswap64(x){ x=BigInt.asUintN(64,BigInt(x)); let r=0n; for(let i=0;i<8;i++){ r=(r<<8n)|(x&0xffn); x>>=8n; } return BigInt.asUintN(64,r); }

// Function table: a proc pointer in linear memory is an integer index into
// `_fns` (WASM's model — JS can't call an integer). `_fnid(fn)` interns a proc to
// its stable index when it's taken as a value; the codegen emits `_fns[idx](args)`
// for an indirect call (a proc variable / closure field). Index 0 is nil.
const _fns = [null];
const _fnmap = new Map();
function _fnid(fn){ let i=_fnmap.get(fn); if(i===undefined){ i=_fns.length; _fns.push(fn); _fnmap.set(fn,i); } return i; }

// C11 memory-order constants (imported by the atomic ops; ignored by the shims).
const __ATOMIC_RELAXED = 0, __ATOMIC_CONSUME = 1, __ATOMIC_ACQUIRE = 2,
      __ATOMIC_RELEASE = 3, __ATOMIC_ACQ_REL = 4, __ATOMIC_SEQ_CST = 5;

// C11 `__atomic_*_n` are generic over the slot type; on this `--bits:32` target
// both ARC refcounts (`rc: int`) and pointers are 4-byte, so every atomic slot
// is 32-bit. JS is single-threaded, so each is a plain read/modify/write. Signed
// `i32` for the fetch ops (the refcount `subFetch < 0` last-ref test), unsigned
// `u32` for the load/store/exchange the allocator's free-lists use for pointers.
function __atomic_add_fetch(p,v,o){ const n=(mem.i32(p)+Number(v))|0; mem.setI32(p,n); return n; }
function __atomic_sub_fetch(p,v,o){ const n=(mem.i32(p)-Number(v))|0; mem.setI32(p,n); return n; }
function __atomic_load_n(p,o){ return mem.u32(p); }
function __atomic_store_n(p,v,o){ mem.setU32(p,Number(v)); }
function __atomic_exchange_n(p,v,o){ const old=mem.u32(p); mem.setU32(p,Number(v)); return old; }
function __atomic_compare_exchange_n(p,exp,des,weak,so,fo){
  // if *p == *exp: *p = des, return true; else *exp = *p, return false
  const cur=mem.u32(p);
  if(cur===mem.u32(exp)){ mem.setU32(p,Number(des)); return true; }
  mem.setU32(exp,cur); return false;
}

// libm functions `importc`'d by std/math. Most map straight onto JS `Math`; the
// few with libm-specific semantics are spelled out (`round` = half away from
// zero, unlike `Math.round`'s half-up; `fmod` = `%`; `copysign`/`signbit` honour
// the sign of -0). The float32 `…f` variants share the double routine (JS has
// only doubles; the extra precision is harmless). Uncommon libm entries not
// covered here (erf/gamma/frexp/fpclassify) are simply never referenced unless a
// program calls them.
const sqrt=Math.sqrt, cbrt=Math.cbrt, exp=Math.exp, sin=Math.sin, cos=Math.cos,
  tan=Math.tan, asin=Math.asin, acos=Math.acos, atan=Math.atan, atan2=Math.atan2,
  sinh=Math.sinh, cosh=Math.cosh, tanh=Math.tanh, asinh=Math.asinh,
  acosh=Math.acosh, atanh=Math.atanh, floor=Math.floor, ceil=Math.ceil,
  trunc=Math.trunc, hypot=Math.hypot, log=Math.log, log2=Math.log2,
  log10=Math.log10, pow=Math.pow;
function fmod(a,b){ return a % b; }
function round(x){ return x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5); }
function copysign(x,y){ return (y < 0 || Object.is(y,-0)) ? -Math.abs(x) : Math.abs(x); }
function isnan(x){ return Number.isNaN(x); }
function signbit(x){ return x < 0 || Object.is(x,-0); }
const sqrtf=sqrt, cbrtf=cbrt, expf=exp, sinf=sin, cosf=cos, tanf=tan, asinf=asin,
  acosf=acos, atanf=atan, atan2f=atan2, sinhf=sinh, coshf=cosh, tanhf=tanh,
  asinhf=asinh, acoshf=acosh, atanhf=atanh, floorf=floor, ceilf=ceil,
  truncf=trunc, hypotf=hypot, logf=log, log2f=log2, log10f=log10, powf=pow,
  roundf=round, fmodf=fmod, copysignf=copysign;

// stdio — distinct stdout/stderr handles; the lowered code passes one as the
// `FILE*`, so route on identity (error/panic reporting goes to stderr).
const stdout = {}, stderr = {};
function _stream(f){ return f === stderr ? process.stderr : process.stdout; }
function fwrite(ptr,size,nmemb,f){ _stream(f).write(Buffer.from(_u8.subarray(ptr,ptr+size*nmemb))); return nmemb; }
function fprintf(f,fmt,...a){ let i=0; _stream(f).write(String(fmt).replace(/%ll[du]|%l[du]|%[dus]/g,()=>String(a[i++]))); }
function fputc(c,f){ _stream(f).write(Buffer.from([c&0xff])); return c; }
function nimFlushStdStreams(){}
function copyMem_0_sysvq0asl(d,s,n){ if(typeof d==='number'&&typeof s==='number') _u8.copyWithin(d,s,s+n); }
function exit(c){ process.exit(Number(c)||0); }

// ── JS-value interop bridge (std/jsffi) ──────────────────────────────────────
// Native Nim data lives in linear memory as byte offsets; a *JS* value (string,
// object, function, DOM node) can't. So Nim holds an integer HANDLE into this
// side table — the generalisation of the `_fns` proc-pointer table above. Slot 0
// is `undefined`/`null` (matches nil = offset 0), freed slots are recycled.
const _jsv = [undefined];
const _jsvFree = [];
function _jsNew(v){                                   // intern a JS value -> handle
  if (v === undefined || v === null) return 0;
  const i = _jsvFree.length ? _jsvFree.pop() : _jsv.length;
  _jsv[i] = v; return i;
}
function _jsRelease(h){ if (h > 0){ _jsv[h] = undefined; _jsvFree.push(h); } }
function _jsvDup(h){ return _jsNew(_jsv[h]); }        // a new slot to the same JS value
function _jsvLive(){ return _jsv.length - 1 - _jsvFree.length; }   // live slot count (leak tests)

// Strings cross the linear-memory boundary as UTF-8 bytes. `_strToJs` decodes a
// (ptr,len) slice of Nim string storage into a real JS string; the read-back is
// two calls (length, then copy) so no scratch region leaks — and since JS
// strings are immutable, both just encode the same handle (no cached state).
const _td = new TextDecoder(), _te = new TextEncoder();
function _strToJs(p, n){ return _jsNew(_td.decode(_u8.subarray(Number(p), Number(p) + Number(n)))); }
function _jsStrLen(h){ return _te.encode(String(_jsv[h])).length; }
function _jsStrInto(h, dst){ _u8.set(_te.encode(String(_jsv[h])), Number(dst)); }

// JS `===` (value/identity), so two distinct handles to the same value compare
// equal — handle-integer equality would not.
function _jsStrictEq(aH, bH){ return _jsv[aH] === _jsv[bH] ? 1 : 0; }

// Number/bool bridges: on --bits:32 a Nim int is already a JS Number.
function _numToJs(x){ return _jsNew(Number(x)); }
function _jsToNum(h){ return _jsv[h]; }
function _boolToJs(x){ return _jsNew(!!x); }
function _jsToBool(h){ return _jsv[h] ? 1 : 0; }

// Global lookup + property/method access, all keyed by JS-string handles so the
// member name itself rides the same marshalling path (no C string constants).
function _jsGlobalH(nameH){ return _jsNew(globalThis[_jsv[nameH]]); }
function _jsGetProp(oH, nameH){ return _jsNew(_jsv[oH][_jsv[nameH]]); }
function _jsSetProp(oH, nameH, vH){ _jsv[oH][_jsv[nameH]] = _jsv[vH]; }
function _jsCall0(oH, nameH){ const o = _jsv[oH]; return _jsNew(o[_jsv[nameH]]()); }
function _jsCall1(oH, nameH, aH){ const o = _jsv[oH]; return _jsNew(o[_jsv[nameH]](_jsv[aH])); }
function _jsCall2(oH, nameH, aH, bH){ const o = _jsv[oH]; return _jsNew(o[_jsv[nameH]](_jsv[aH], _jsv[bH])); }
function _jsCall3(oH, nameH, aH, bH, cH){ const o = _jsv[oH]; return _jsNew(o[_jsv[nameH]](_jsv[aH], _jsv[bH], _jsv[cH])); }
function _jsNewObject(){ return _jsNew({}); }

// `new Ctor(...)` construction.
function _jsCtor0(ctorH){ return _jsNew(new (_jsv[ctorH])()); }
function _jsCtor1(ctorH, aH){ return _jsNew(new (_jsv[ctorH])(_jsv[aH])); }
// `new Ctor(...args)` for any arity: args is a JS array handle, spread via Reflect.
function _jsCtorN(ctorH, argsH){ return _jsNew(Reflect.construct(_jsv[ctorH], _jsv[argsH])); }

// JS arrays. An array is just another JS value in the table; `_jsArrGet` interns
// a *new* handle to the element (owned by the returned JsValue), and `push`/set
// hand the array a direct reference to the element value — so releasing the Nim
// handle slot afterwards never disturbs the array's own reference (JS GC keeps
// the value alive as long as the array does). Floats need no bridge of their
// own: on --bits:32 a Nim float is already a JS Number, so `toJs(float)` reuses
// `_numToJs` and `toFloat` reuses `_jsToNum`.
function _jsNewArray(){ return _jsNew([]); }
function _jsArrLen(h){ return _jsv[h].length; }
function _jsArrPush(h, vH){ _jsv[h].push(_jsv[vH]); }
function _jsArrGet(h, i){ return _jsNew(_jsv[h][Number(i)]); }
function _jsArrSet(h, i, vH){ _jsv[h][Number(i)] = _jsv[vH]; }

// Introspection: `typeof`, `in`, `instanceof`. A DOM binding branches on these
// constantly (a node's type, whether a property exists, an Array vs a NodeList).
function _jsTypeof(h){ return _jsNew(typeof _jsv[h]); }
function _jsHasProp(oH, nameH){ return (_jsv[nameH] in _jsv[oH]) ? 1 : 0; }
function _jsInstanceOf(vH, ctorH){ return (_jsv[vH] instanceof _jsv[ctorH]) ? 1 : 0; }

// `obj.name(...args)` for any argument count (beyond the fixed _jsCall0..3): the
// Nim side marshals the args into a JS array, we spread it via Function.apply.
function _jsApply(oH, nameH, argsH){ const o = _jsv[oH]; return _jsNew(o[_jsv[nameH]].apply(o, _jsv[argsH])); }

// Nim proc -> JS function (the reverse of the _fns call table): a Nim proc used
// as a value lowers to an integer _fns index, so wrap that in a JS closure. The
// closure marshals each incoming JS argument to a `JsValue` — which the backend
// represents as a one-field `{h: int32}` object, i.e. 4 bytes in linear memory
// with the handle at offset 0 — and passes that object's byte offset (the ABI a
// Nim `proc(ev: JsValue)` expects). The Nim callback borrows the argument, so we
// release the handle after it returns; an event object is only valid for the
// duration of dispatch, matching the DOM contract.
function _fnToJs0(idx){ return _jsNew(() => { _fns[idx](); }); }
function _fnToJs1(idx){
  return _jsNew((a) => {
    const h = _jsNew(a);
    const p = allocFixed(4); mem.setI32(p, h);   // a JsValue {h} object for the ABI
    _fns[idx](p);
    _jsRelease(h);
  });
}


let strlit_0_I16254714811886502893_party5a2l1 = allocFixed(17);

let strlit_0_I10206930254104378444_nifjp9lau1 = allocFixed(31);

let strlit_0_I738618324702527352_nifjp9lau1 = allocFixed(38);

let strlit_0_I7901555537561129428_nifjp9lau1 = allocFixed(28);

let strlit_0_I2641880525336905210_nifjp9lau1 = allocFixed(33);

let strlit_0_I6985518380653593946_nifjp9lau1 = allocFixed(16);

let strlit_0_I12182831138765611011_nifjp9lau1 = allocFixed(16);

let strlit_0_I10166291543601148343_nifjp9lau1 = allocFixed(19);

let strlit_0_I17577884300256341180_nifjp9lau1 = allocFixed(16);

let strlit_0_I2857462522550599008_nifjp9lau1 = allocFixed(55);

let strlit_0_I7652740792648692536_nifjp9lau1 = allocFixed(21);

let strlit_0_I2246750106930142149_nifjp9lau1 = allocFixed(21);

let strlit_0_I15962761803738331083_nifjp9lau1 = allocFixed(22);

let ControlChars_0_nifjp9lau1 = allocFixed(32);

let strlit_0_I14798179864757096681_lex3r1urc1 = allocFixed(16);

let strlit_0_I16254591112882230105_lex3r1urc1 = allocFixed(16);

let OperatorChars_0_lex3r1urc1 = allocFixed(32);

let QQuoteMergeChars_0_lex3r1urc1 = allocFixed(32);

let strlit_0_I8031254106179394417_dir38pj6l = allocFixed(36);

let strlit_0_I1290833423478922541_parq39nt2 = allocFixed(18);

let strlit_0_I17352810006323012799_parq39nt2 = allocFixed(17);

let strlit_0_I18205123775845960279_parq39nt2 = allocFixed(17);

let strlit_0_I15371509460875483150_parq39nt2 = allocFixed(16);

let strlit_0_I4956278306908871092_parq39nt2 = allocFixed(16);

let strlit_0_I4167480082662538754_parq39nt2 = allocFixed(16);

let strlit_0_I13424873862977158440_parq39nt2 = allocFixed(16);

let strlit_0_I13752166055203769914_parq39nt2 = allocFixed(17);

let strlit_0_I13909093427330098489_parq39nt2 = allocFixed(16);

let strlit_0_I9217337746930322866_parq39nt2 = allocFixed(22);

let strlit_0_I8954722698363393223_parq39nt2 = allocFixed(18);

let strlit_0_I9557201018976274010_parq39nt2 = allocFixed(16);

let strlit_0_I9991102891510134496_parq39nt2 = allocFixed(16);

let strlit_0_I9071657656589967445_parq39nt2 = allocFixed(20);

let strlit_0_I5316556160589403975_parq39nt2 = allocFixed(16);

let strlit_0_I14781640258047403316_parq39nt2 = allocFixed(16);

let strlit_0_I14293528690183020870_parq39nt2 = allocFixed(19);

let strlit_0_I7084116572891045059_parq39nt2 = allocFixed(19);

let strlit_0_I1707222714195181991_parq39nt2 = allocFixed(16);

let strlit_0_I9830314142150548690_parq39nt2 = allocFixed(17);

let strlit_0_I13200118161122656888_parq39nt2 = allocFixed(17);

let strlit_0_I13798915436014509391_parq39nt2 = allocFixed(16);

let strlit_0_I14055597598996035090_parq39nt2 = allocFixed(19);

let strlit_0_I16361658452647583931_parq39nt2 = allocFixed(21);

let strlit_0_I10209608037894561257_parq39nt2 = allocFixed(17);

let strlit_0_I8390060478375454995_parq39nt2 = allocFixed(17);

let strlit_0_I3021806080610957510_parq39nt2 = allocFixed(20);

let strlit_0_I18086024188298164462_parq39nt2 = allocFixed(17);

let strlit_0_I15938251790995683266_parq39nt2 = allocFixed(20);

let strlit_0_I1995551610468546737_parq39nt2 = allocFixed(20);

let strlit_0_I7023501325319911082_parq39nt2 = allocFixed(19);

let strlit_0_I3759916806223351059_parq39nt2 = allocFixed(19);

let strlit_0_I14656641239204103783_parq39nt2 = allocFixed(20);

let strlit_0_I10760563625686142994_parq39nt2 = allocFixed(18);

let strlit_0_I973692718279674627_parq39nt2 = allocFixed(18);

let strlit_0_I10462096440466995513_parq39nt2 = allocFixed(16);

let strlit_0_I2171368188661376471_parq39nt2 = allocFixed(16);

let strlit_0_I2544717250931810611_parq39nt2 = allocFixed(19);

let strlit_0_I13413619771642637377_parq39nt2 = allocFixed(16);

let strlit_0_I5367917178860180580_parq39nt2 = allocFixed(18);

let strlit_0_I9792473688321036479_parq39nt2 = allocFixed(17);

let strlit_0_I2681092370707159476_parq39nt2 = allocFixed(16);

let strlit_0_I18082762212279024255_parq39nt2 = allocFixed(19);

let strlit_0_I4167773820130397069_parq39nt2 = allocFixed(17);

let strlit_0_I16264910594287870354_parq39nt2 = allocFixed(18);

let strlit_0_I1237672436915077942_parq39nt2 = allocFixed(21);

let strlit_0_I13179338205702368459_parq39nt2 = allocFixed(22);

let strlit_0_I7731358638274129439_parq39nt2 = allocFixed(22);

let strlit_0_I17199005983847516849_parq39nt2 = allocFixed(19);

let strlit_0_I10578126245728228512_parq39nt2 = allocFixed(18);

let strlit_0_I3199637833187763350_parq39nt2 = allocFixed(22);

let strlit_0_I4843651051758684618_parq39nt2 = allocFixed(22);

let strlit_0_I18257730313531980409_parq39nt2 = allocFixed(19);

let strlit_0_I2956720964102846418_parq39nt2 = allocFixed(19);

let strlit_0_I6517805684605582485_parq39nt2 = allocFixed(18);

let strlit_0_I3777428167486794959_parq39nt2 = allocFixed(17);

let strlit_0_I12427448230105600699_parq39nt2 = allocFixed(18);

let strlit_0_I6137881024046402116_parq39nt2 = allocFixed(17);

let strlit_0_I17987658270787974407_parq39nt2 = allocFixed(20);

let strlit_0_I16137783760080910327_parq39nt2 = allocFixed(17);

let strlit_0_I8380221545607033154_parq39nt2 = allocFixed(17);

let strlit_0_I12999086881046019782_parq39nt2 = allocFixed(17);

let strlit_0_I6864681898360807206_parq39nt2 = allocFixed(21);

let strlit_0_I2210116261907819816_parq39nt2 = allocFixed(20);

let strlit_0_I6313045265747232047_parq39nt2 = allocFixed(18);

let strlit_0_I3312144845751804851_parq39nt2 = allocFixed(19);

let strlit_0_I17569086427026686584_parq39nt2 = allocFixed(18);

let strlit_0_I16958549946995210046_parq39nt2 = allocFixed(21);

let strlit_0_I15261117590630161161_parq39nt2 = allocFixed(22);

let BinaryKeywords_0_parq39nt2 = allocFixed(112);

let strlit_0_I14872370265633446329_str7j0ifg = allocFixed(100);

let strlit_0_I14532204288076119502_envto7w6l1 = allocFixed(98);

let strlit_0_I14676000009897902695_assy765wm = allocFixed(32);

let strlit_0_I18337270522941735704_tok9e79hf = allocFixed(16);

let strlit_0_I11374605019106816382_tok9e79hf = allocFixed(21);

let strlit_0_I6669728318263290480_tok9e79hf = allocFixed(17);

let strlit_0_I15803870852433253359_tok9e79hf = allocFixed(17);

let Keywords_0_tok9e79hf = allocFixed(528);

let strlit_0_I8436252750452789659_websvfj9k1 = allocFixed(39);

let strlit_0_I7436273935627428487_websvfj9k1 = allocFixed(45);

let strlit_0_I14740933442681856299_websvfj9k1 = allocFixed(49);

let strlit_0_I5838082098074422888_websvfj9k1 = allocFixed(43);

let strlit_0_I11780787593763197124_websvfj9k1 = allocFixed(42);

let strlit_0_I12890960710833486046_websvfj9k1 = allocFixed(42);

let strlit_0_I15867609858545661460_websvfj9k1 = allocFixed(42);

let strlit_0_I17451209550239811446_websvfj9k1 = allocFixed(16);

let strlit_0_I621061182478469467_websvfj9k1 = allocFixed(16);

let strlit_0_I15160080286962768302_websvfj9k1 = allocFixed(16);

let strlit_0_I16111832319537461242_websvfj9k1 = allocFixed(30);

let strlit_0_I2791062431570189588_websvfj9k1 = allocFixed(32);

let strlit_0_I5340874533979027814_websvfj9k1 = allocFixed(23);

let strlit_0_I13544407097396288341_websvfj9k1 = allocFixed(23);

let strlit_0_I7528375458768032574_websvfj9k1 = allocFixed(21);

let strlit_0_I17487054685970555778_websvfj9k1 = allocFixed(87);

let strlit_0_I6105018409752412263_webzywwor1 = allocFixed(28);

let strlit_0_I4645790987703279553_webzywwor1 = allocFixed(16);

let strlit_0_I1077588883665121262_webzywwor1 = allocFixed(20);

let strlit_0_I7115103054454119625_webzywwor1 = allocFixed(19);

let strlit_0_I8163788669936926653_webzywwor1 = allocFixed(24);

let strlit_0_I16858515255358452405_webzywwor1 = allocFixed(20);

let strlit_0_I9665133714172714337_webzywwor1 = allocFixed(21);

let strlit_0_I12157574297857663135_webzywwor1 = allocFixed(18);

let strlit_0_I12129343431845544526_webzywwor1 = allocFixed(22);

let strlit_0_I16664880105326712979_webzywwor1 = allocFixed(22);

let strlit_0_I7810566879425797473_webzywwor1 = allocFixed(20);

let strlit_0_I6187027680374537400_webzywwor1 = allocFixed(21);

let strlit_0_I15750996627617194403_cmdqs323n1 = allocFixed(31);

let strlit_0_I14131790745264837101_sysvq0asl = allocFixed(102);

let strlit_0_I11927585966806674622_sysvq0asl = allocFixed(102);

let strlit_0_I15539159382304113184_sysvq0asl = allocFixed(39);

let strlit_0_I14281474217946372742_sysvq0asl = allocFixed(47);

let strlit_0_I16690852185662743073_sysvq0asl = allocFixed(28);

let strlit_0_I10604297744791418982_sysvq0asl = allocFixed(30);

let strlit_0_I11614695157650328859_sysvq0asl = allocFixed(33);

let strlit_0_I16845119709590674135_sysvq0asl = allocFixed(19);

let NegTen_0_sysvq0asl = allocFixed(80);

let fsLookupTable_0_sysvq0asl = allocFixed(256);

let trailingZeros100_0_sysvq0asl = allocFixed(100);

let digits100_0_sysvq0asl = allocFixed(200);

let strlit_0_I14694606176902936784_has9tn57v = allocFixed(104);

mem.setI32(strlit_0_I16254714811886502893_party5a2l1, 5);

mem.setI32((strlit_0_I16254714811886502893_party5a2l1 + 4), 0);

mem.setI32((strlit_0_I16254714811886502893_party5a2l1 + 8), 0);

mem.writeStr((strlit_0_I16254714811886502893_party5a2l1 + 12), "e+000");

mem.setI32(strlit_0_I10206930254104378444_nifjp9lau1, 19);

mem.setI32((strlit_0_I10206930254104378444_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I10206930254104378444_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I10206930254104378444_nifjp9lau1 + 12), "unpaired '(' or ')'");

mem.setI32(strlit_0_I738618324702527352_nifjp9lau1, 26);

mem.setI32((strlit_0_I738618324702527352_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I738618324702527352_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I738618324702527352_nifjp9lau1 + 12), "cannot extract from a file");

mem.setI32(strlit_0_I7901555537561129428_nifjp9lau1, 16);

mem.setI32((strlit_0_I7901555537561129428_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I7901555537561129428_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I7901555537561129428_nifjp9lau1 + 12), "0123456789ABCDEF");

mem.setI32(strlit_0_I2641880525336905210_nifjp9lau1, 21);

mem.setI32((strlit_0_I2641880525336905210_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I2641880525336905210_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I2641880525336905210_nifjp9lau1 + 12), "no separator required");

mem.setI32(strlit_0_I6985518380653593946_nifjp9lau1, 4);

mem.setI32((strlit_0_I6985518380653593946_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I6985518380653593946_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I6985518380653593946_nifjp9lau1 + 12), "(inf");

mem.setI32(strlit_0_I12182831138765611011_nifjp9lau1, 4);

mem.setI32((strlit_0_I12182831138765611011_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I12182831138765611011_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I12182831138765611011_nifjp9lau1 + 12), "(nan");

mem.setI32(strlit_0_I10166291543601148343_nifjp9lau1, 7);

mem.setI32((strlit_0_I10166291543601148343_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I10166291543601148343_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I10166291543601148343_nifjp9lau1 + 12), "(neginf");

mem.setI32(strlit_0_I17577884300256341180_nifjp9lau1, 4);

mem.setI32((strlit_0_I17577884300256341180_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I17577884300256341180_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I17577884300256341180_nifjp9lau1 + 12), "-0.0");

mem.setI32(strlit_0_I2857462522550599008_nifjp9lau1, 43);

mem.setI32((strlit_0_I2857462522550599008_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I2857462522550599008_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I2857462522550599008_nifjp9lau1 + 12), "generating ')' would produce a syntax error");

mem.setI32(strlit_0_I7652740792648692536_nifjp9lau1, 9);

mem.setI32((strlit_0_I7652740792648692536_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I7652740792648692536_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I7652740792648692536_nifjp9lau1 + 12), "(.nif27)\n");

mem.setI32(strlit_0_I2246750106930142149_nifjp9lau1, 9);

mem.setI32((strlit_0_I2246750106930142149_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I2246750106930142149_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I2246750106930142149_nifjp9lau1 + 12), "(.vendor ");

mem.setI32(strlit_0_I15962761803738331083_nifjp9lau1, 10);

mem.setI32((strlit_0_I15962761803738331083_nifjp9lau1 + 4), 0);

mem.setI32((strlit_0_I15962761803738331083_nifjp9lau1 + 8), 0);

mem.writeStr((strlit_0_I15962761803738331083_nifjp9lau1 + 12), "(.dialect ");

mem.setU8(ControlChars_0_nifjp9lau1, 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 1), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 2), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 3), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 4), 140);

mem.setU8((ControlChars_0_nifjp9lau1 + 5), 3);

mem.setU8((ControlChars_0_nifjp9lau1 + 6), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 7), 4);

mem.setU8((ControlChars_0_nifjp9lau1 + 8), 1);

mem.setU8((ControlChars_0_nifjp9lau1 + 9), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 10), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 11), 56);

mem.setU8((ControlChars_0_nifjp9lau1 + 12), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 13), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 14), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 15), 104);

mem.setU8((ControlChars_0_nifjp9lau1 + 16), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 17), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 18), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 19), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 20), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 21), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 22), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 23), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 24), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 25), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 26), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 27), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 28), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 29), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 30), 0);

mem.setU8((ControlChars_0_nifjp9lau1 + 31), 0);

mem.setI32(strlit_0_I14798179864757096681_lex3r1urc1, 4);

mem.setI32((strlit_0_I14798179864757096681_lex3r1urc1 + 4), 0);

mem.setI32((strlit_0_I14798179864757096681_lex3r1urc1 + 8), 0);

mem.writeStr((strlit_0_I14798179864757096681_lex3r1urc1 + 12), "F128");

mem.setI32(strlit_0_I16254591112882230105_lex3r1urc1, 4);

mem.setI32((strlit_0_I16254591112882230105_lex3r1urc1 + 4), 0);

mem.setI32((strlit_0_I16254591112882230105_lex3r1urc1 + 8), 0);

mem.writeStr((strlit_0_I16254591112882230105_lex3r1urc1 + 12), "f128");

mem.setU8(OperatorChars_0_lex3r1urc1, 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 1), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 2), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 3), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 4), 114);

mem.setU8((OperatorChars_0_lex3r1urc1 + 5), 236);

mem.setU8((OperatorChars_0_lex3r1urc1 + 6), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 7), 244);

mem.setU8((OperatorChars_0_lex3r1urc1 + 8), 1);

mem.setU8((OperatorChars_0_lex3r1urc1 + 9), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 10), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 11), 80);

mem.setU8((OperatorChars_0_lex3r1urc1 + 12), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 13), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 14), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 15), 80);

mem.setU8((OperatorChars_0_lex3r1urc1 + 16), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 17), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 18), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 19), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 20), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 21), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 22), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 23), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 24), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 25), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 26), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 27), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 28), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 29), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 30), 0);

mem.setU8((OperatorChars_0_lex3r1urc1 + 31), 0);

mem.setU8(QQuoteMergeChars_0_lex3r1urc1, 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 1), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 2), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 3), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 4), 114);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 5), 239);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 6), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 7), 240);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 8), 1);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 9), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 10), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 11), 120);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 12), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 13), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 14), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 15), 120);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 16), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 17), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 18), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 19), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 20), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 21), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 22), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 23), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 24), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 25), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 26), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 27), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 28), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 29), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 30), 0);

mem.setU8((QQuoteMergeChars_0_lex3r1urc1 + 31), 0);

mem.setI32(strlit_0_I8031254106179394417_dir38pj6l, 24);

mem.setI32((strlit_0_I8031254106179394417_dir38pj6l + 4), 0);

mem.setI32((strlit_0_I8031254106179394417_dir38pj6l + 8), 0);

mem.writeStr((strlit_0_I8031254106179394417_dir38pj6l + 12), "ignore runnable examples");

mem.setI32(strlit_0_I1290833423478922541_parq39nt2, 6);

mem.setI32((strlit_0_I1290833423478922541_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I1290833423478922541_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I1290833423478922541_parq39nt2 + 12), "quoted");

mem.setI32(strlit_0_I17352810006323012799_parq39nt2, 5);

mem.setI32((strlit_0_I17352810006323012799_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I17352810006323012799_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I17352810006323012799_parq39nt2 + 12), "notin");

mem.setI32(strlit_0_I18205123775845960279_parq39nt2, 5);

mem.setI32((strlit_0_I18205123775845960279_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I18205123775845960279_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I18205123775845960279_parq39nt2 + 12), "isnot");

mem.setI32(strlit_0_I15371509460875483150_parq39nt2, 4);

mem.setI32((strlit_0_I15371509460875483150_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I15371509460875483150_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I15371509460875483150_parq39nt2 + 12), "from");

mem.setI32(strlit_0_I4956278306908871092_parq39nt2, 4);

mem.setI32((strlit_0_I4956278306908871092_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I4956278306908871092_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I4956278306908871092_parq39nt2 + 12), "case");

mem.setI32(strlit_0_I4167480082662538754_parq39nt2, 4);

mem.setI32((strlit_0_I4167480082662538754_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I4167480082662538754_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I4167480082662538754_parq39nt2 + 12), "else");

mem.setI32(strlit_0_I13424873862977158440_parq39nt2, 4);

mem.setI32((strlit_0_I13424873862977158440_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I13424873862977158440_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I13424873862977158440_parq39nt2 + 12), "elif");

mem.setI32(strlit_0_I13752166055203769914_parq39nt2, 5);

mem.setI32((strlit_0_I13752166055203769914_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I13752166055203769914_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I13752166055203769914_parq39nt2 + 12), "stmts");

mem.setI32(strlit_0_I13909093427330098489_parq39nt2, 4);

mem.setI32((strlit_0_I13909093427330098489_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I13909093427330098489_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I13909093427330098489_parq39nt2 + 12), "cast");

mem.setI32(strlit_0_I9217337746930322866_parq39nt2, 10);

mem.setI32((strlit_0_I9217337746930322866_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I9217337746930322866_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I9217337746930322866_parq39nt2 + 12), "callstrlit");

mem.setI32(strlit_0_I8954722698363393223_parq39nt2, 6);

mem.setI32((strlit_0_I8954722698363393223_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I8954722698363393223_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I8954722698363393223_parq39nt2 + 12), "prefix");

mem.setI32(strlit_0_I9557201018976274010_parq39nt2, 4);

mem.setI32((strlit_0_I9557201018976274010_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I9557201018976274010_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I9557201018976274010_parq39nt2 + 12), "addr");

mem.setI32(strlit_0_I9991102891510134496_parq39nt2, 4);

mem.setI32((strlit_0_I9991102891510134496_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I9991102891510134496_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I9991102891510134496_parq39nt2 + 12), "func");

mem.setI32(strlit_0_I9071657656589967445_parq39nt2, 8);

mem.setI32((strlit_0_I9071657656589967445_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I9071657656589967445_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I9071657656589967445_parq39nt2 + 12), "iterator");

mem.setI32(strlit_0_I5316556160589403975_parq39nt2, 4);

mem.setI32((strlit_0_I5316556160589403975_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I5316556160589403975_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I5316556160589403975_parq39nt2 + 12), "proc");

mem.setI32(strlit_0_I14781640258047403316_parq39nt2, 4);

mem.setI32((strlit_0_I14781640258047403316_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I14781640258047403316_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I14781640258047403316_parq39nt2 + 12), "when");

mem.setI32(strlit_0_I14293528690183020870_parq39nt2, 7);

mem.setI32((strlit_0_I14293528690183020870_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I14293528690183020870_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I14293528690183020870_parq39nt2 + 12), "curlyat");

mem.setI32(strlit_0_I7084116572891045059_parq39nt2, 7);

mem.setI32((strlit_0_I7084116572891045059_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I7084116572891045059_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I7084116572891045059_parq39nt2 + 12), "oconstr");

mem.setI32(strlit_0_I1707222714195181991_parq39nt2, 4);

mem.setI32((strlit_0_I1707222714195181991_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I1707222714195181991_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I1707222714195181991_parq39nt2 + 12), "call");

mem.setI32(strlit_0_I9830314142150548690_parq39nt2, 5);

mem.setI32((strlit_0_I9830314142150548690_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I9830314142150548690_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I9830314142150548690_parq39nt2 + 12), "block");

mem.setI32(strlit_0_I13200118161122656888_parq39nt2, 5);

mem.setI32((strlit_0_I13200118161122656888_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I13200118161122656888_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I13200118161122656888_parq39nt2 + 12), "while");

mem.setI32(strlit_0_I13798915436014509391_parq39nt2, 4);

mem.setI32((strlit_0_I13798915436014509391_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I13798915436014509391_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I13798915436014509391_parq39nt2 + 12), "expr");

mem.setI32(strlit_0_I14055597598996035090_parq39nt2, 7);

mem.setI32((strlit_0_I14055597598996035090_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I14055597598996035090_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I14055597598996035090_parq39nt2 + 12), "bracket");

mem.setI32(strlit_0_I16361658452647583931_parq39nt2, 9);

mem.setI32((strlit_0_I16361658452647583931_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I16361658452647583931_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I16361658452647583931_parq39nt2 + 12), "tabconstr");

mem.setI32(strlit_0_I10209608037894561257_parq39nt2, 5);

mem.setI32((strlit_0_I10209608037894561257_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I10209608037894561257_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I10209608037894561257_parq39nt2 + 12), "curly");

mem.setI32(strlit_0_I8390060478375454995_parq39nt2, 5);

mem.setI32((strlit_0_I8390060478375454995_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I8390060478375454995_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I8390060478375454995_parq39nt2 + 12), "infix");

mem.setI32(strlit_0_I3021806080610957510_parq39nt2, 8);

mem.setI32((strlit_0_I3021806080610957510_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I3021806080610957510_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I3021806080610957510_parq39nt2 + 12), "distinct");

mem.setI32(strlit_0_I18086024188298164462_parq39nt2, 5);

mem.setI32((strlit_0_I18086024188298164462_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I18086024188298164462_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I18086024188298164462_parq39nt2 + 12), "tuple");

mem.setI32(strlit_0_I15938251790995683266_parq39nt2, 8);

mem.setI32((strlit_0_I15938251790995683266_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I15938251790995683266_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I15938251790995683266_parq39nt2 + 12), "itertype");

mem.setI32(strlit_0_I1995551610468546737_parq39nt2, 8);

mem.setI32((strlit_0_I1995551610468546737_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I1995551610468546737_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I1995551610468546737_parq39nt2 + 12), "proctype");

mem.setI32(strlit_0_I7023501325319911082_parq39nt2, 7);

mem.setI32((strlit_0_I7023501325319911082_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I7023501325319911082_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I7023501325319911082_parq39nt2 + 12), "pragmas");

mem.setI32(strlit_0_I3759916806223351059_parq39nt2, 7);

mem.setI32((strlit_0_I3759916806223351059_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I3759916806223351059_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I3759916806223351059_parq39nt2 + 12), "typevar");

mem.setI32(strlit_0_I14656641239204103783_parq39nt2, 8);

mem.setI32((strlit_0_I14656641239204103783_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I14656641239204103783_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I14656641239204103783_parq39nt2 + 12), "typevars");

mem.setI32(strlit_0_I10760563625686142994_parq39nt2, 6);

mem.setI32((strlit_0_I10760563625686142994_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I10760563625686142994_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I10760563625686142994_parq39nt2 + 12), "ranges");

mem.setI32(strlit_0_I973692718279674627_parq39nt2, 6);

mem.setI32((strlit_0_I973692718279674627_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I973692718279674627_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I973692718279674627_parq39nt2 + 12), "object");

mem.setI32(strlit_0_I10462096440466995513_parq39nt2, 4);

mem.setI32((strlit_0_I10462096440466995513_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I10462096440466995513_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I10462096440466995513_parq39nt2 + 12), "enum");

mem.setI32(strlit_0_I2171368188661376471_parq39nt2, 4);

mem.setI32((strlit_0_I2171368188661376471_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I2171368188661376471_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I2171368188661376471_parq39nt2 + 12), "efld");

mem.setI32(strlit_0_I2544717250931810611_parq39nt2, 7);

mem.setI32((strlit_0_I2544717250931810611_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I2544717250931810611_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I2544717250931810611_parq39nt2 + 12), "concept");

mem.setI32(strlit_0_I13413619771642637377_parq39nt2, 4);

mem.setI32((strlit_0_I13413619771642637377_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I13413619771642637377_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I13413619771642637377_parq39nt2 + 12), "type");

mem.setI32(strlit_0_I5367917178860180580_parq39nt2, 6);

mem.setI32((strlit_0_I5367917178860180580_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I5367917178860180580_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I5367917178860180580_parq39nt2 + 12), "params");

mem.setI32(strlit_0_I9792473688321036479_parq39nt2, 5);

mem.setI32((strlit_0_I9792473688321036479_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I9792473688321036479_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I9792473688321036479_parq39nt2 + 12), "param");

mem.setI32(strlit_0_I2681092370707159476_parq39nt2, 4);

mem.setI32((strlit_0_I2681092370707159476_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I2681092370707159476_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I2681092370707159476_parq39nt2 + 12), "asgn");

mem.setI32(strlit_0_I18082762212279024255_parq39nt2, 7);

mem.setI32((strlit_0_I18082762212279024255_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I18082762212279024255_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I18082762212279024255_parq39nt2 + 12), "finally");

mem.setI32(strlit_0_I4167773820130397069_parq39nt2, 5);

mem.setI32((strlit_0_I4167773820130397069_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I4167773820130397069_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I4167773820130397069_parq39nt2 + 12), "defer");

mem.setI32(strlit_0_I16264910594287870354_parq39nt2, 6);

mem.setI32((strlit_0_I16264910594287870354_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I16264910594287870354_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I16264910594287870354_parq39nt2 + 12), "except");

mem.setI32(strlit_0_I1237672436915077942_parq39nt2, 9);

mem.setI32((strlit_0_I1237672436915077942_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I1237672436915077942_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I1237672436915077942_parq39nt2 + 12), "unpacktup");

mem.setI32(strlit_0_I13179338205702368459_parq39nt2, 10);

mem.setI32((strlit_0_I13179338205702368459_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I13179338205702368459_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I13179338205702368459_parq39nt2 + 12), "unpackflat");

mem.setI32(strlit_0_I7731358638274129439_parq39nt2, 10);

mem.setI32((strlit_0_I7731358638274129439_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I7731358638274129439_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I7731358638274129439_parq39nt2 + 12), "unpackdecl");

mem.setI32(strlit_0_I17199005983847516849_parq39nt2, 7);

mem.setI32((strlit_0_I17199005983847516849_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I17199005983847516849_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I17199005983847516849_parq39nt2 + 12), "pragmax");

mem.setI32(strlit_0_I10578126245728228512_parq39nt2, 6);

mem.setI32((strlit_0_I10578126245728228512_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I10578126245728228512_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I10578126245728228512_parq39nt2 + 12), "import");

mem.setI32(strlit_0_I3199637833187763350_parq39nt2, 10);

mem.setI32((strlit_0_I3199637833187763350_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I3199637833187763350_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I3199637833187763350_parq39nt2 + 12), "fromimport");

mem.setI32(strlit_0_I4843651051758684618_parq39nt2, 10);

mem.setI32((strlit_0_I4843651051758684618_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I4843651051758684618_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I4843651051758684618_parq39nt2 + 12), "staticstmt");

mem.setI32(strlit_0_I18257730313531980409_parq39nt2, 7);

mem.setI32((strlit_0_I18257730313531980409_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I18257730313531980409_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I18257730313531980409_parq39nt2 + 12), "comment");

mem.setI32(strlit_0_I2956720964102846418_parq39nt2, 7);

mem.setI32((strlit_0_I2956720964102846418_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I2956720964102846418_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I2956720964102846418_parq39nt2 + 12), "discard");

mem.setI32(strlit_0_I6517805684605582485_parq39nt2, 6);

mem.setI32((strlit_0_I6517805684605582485_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I6517805684605582485_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I6517805684605582485_parq39nt2 + 12), "method");

mem.setI32(strlit_0_I3777428167486794959_parq39nt2, 5);

mem.setI32((strlit_0_I3777428167486794959_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I3777428167486794959_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I3777428167486794959_parq39nt2 + 12), "macro");

mem.setI32(strlit_0_I12427448230105600699_parq39nt2, 6);

mem.setI32((strlit_0_I12427448230105600699_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I12427448230105600699_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I12427448230105600699_parq39nt2 + 12), "return");

mem.setI32(strlit_0_I6137881024046402116_parq39nt2, 5);

mem.setI32((strlit_0_I6137881024046402116_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I6137881024046402116_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I6137881024046402116_parq39nt2 + 12), "raise");

mem.setI32(strlit_0_I17987658270787974407_parq39nt2, 8);

mem.setI32((strlit_0_I17987658270787974407_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I17987658270787974407_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I17987658270787974407_parq39nt2 + 12), "template");

mem.setI32(strlit_0_I16137783760080910327_parq39nt2, 5);

mem.setI32((strlit_0_I16137783760080910327_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I16137783760080910327_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I16137783760080910327_parq39nt2 + 12), "yield");

mem.setI32(strlit_0_I8380221545607033154_parq39nt2, 5);

mem.setI32((strlit_0_I8380221545607033154_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I8380221545607033154_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I8380221545607033154_parq39nt2 + 12), "break");

mem.setI32(strlit_0_I12999086881046019782_parq39nt2, 5);

mem.setI32((strlit_0_I12999086881046019782_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I12999086881046019782_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I12999086881046019782_parq39nt2 + 12), "const");

mem.setI32(strlit_0_I6864681898360807206_parq39nt2, 9);

mem.setI32((strlit_0_I6864681898360807206_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I6864681898360807206_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I6864681898360807206_parq39nt2 + 12), "converter");

mem.setI32(strlit_0_I2210116261907819816_parq39nt2, 8);

mem.setI32((strlit_0_I2210116261907819816_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I2210116261907819816_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I2210116261907819816_parq39nt2 + 12), "continue");

mem.setI32(strlit_0_I6313045265747232047_parq39nt2, 6);

mem.setI32((strlit_0_I6313045265747232047_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I6313045265747232047_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I6313045265747232047_parq39nt2 + 12), "export");

mem.setI32(strlit_0_I3312144845751804851_parq39nt2, 7);

mem.setI32((strlit_0_I3312144845751804851_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I3312144845751804851_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I3312144845751804851_parq39nt2 + 12), "include");

mem.setI32(strlit_0_I17569086427026686584_parq39nt2, 6);

mem.setI32((strlit_0_I17569086427026686584_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I17569086427026686584_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I17569086427026686584_parq39nt2 + 12), "static");

mem.setI32(strlit_0_I16958549946995210046_parq39nt2, 9);

mem.setI32((strlit_0_I16958549946995210046_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I16958549946995210046_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I16958549946995210046_parq39nt2 + 12), "nifparser");

mem.setI32(strlit_0_I15261117590630161161_parq39nt2, 10);

mem.setI32((strlit_0_I15261117590630161161_parq39nt2 + 4), 0);

mem.setI32((strlit_0_I15261117590630161161_parq39nt2 + 8), 0);

mem.writeStr((strlit_0_I15261117590630161161_parq39nt2 + 12), "nim-parsed");

mem.copy(BinaryKeywords_0_parq39nt2, (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1986618371);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 8), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1685024003);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 16), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1818784515);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 24), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1919447811);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 32), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1684955395);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 40), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 7499522);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 48), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1919907843);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 56), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 7235842);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 64), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1953459966);
  mem.setU32((_o + 4), strlit_0_I17352810006323012799_parq39nt2);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 72), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 7563522);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 80), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1853057534);
  mem.setU32((_o + 4), strlit_0_I18205123775845960279_parq39nt2);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 88), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 6713090);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 96), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 7561474);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((BinaryKeywords_0_parq39nt2 + 104), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1869768446);
  mem.setU32((_o + 4), strlit_0_I15371509460875483150_parq39nt2);
  return _o;
})(), 8);

mem.setI32(strlit_0_I14872370265633446329_str7j0ifg, 88);

mem.setI32((strlit_0_I14872370265633446329_str7j0ifg + 4), 0);

mem.setI32((strlit_0_I14872370265633446329_str7j0ifg + 8), 0);

mem.writeStr((strlit_0_I14872370265633446329_str7j0ifg + 12), "../nimony/lib/std/system/openarrays.nim(12, 59): 0 <= i and i < x.len [AssertionDefect]\n");

mem.setI32(strlit_0_I14532204288076119502_envto7w6l1, 86);

mem.setI32((strlit_0_I14532204288076119502_envto7w6l1 + 4), 0);

mem.setI32((strlit_0_I14532204288076119502_envto7w6l1 + 8), 0);

mem.writeStr((strlit_0_I14532204288076119502_envto7w6l1 + 12), "../nimony/lib/std/system/seqimpl.nim(167, 41): i < s.len and 0 <= i [AssertionDefect]\n");

mem.setI32(strlit_0_I14676000009897902695_assy765wm, 20);

mem.setI32((strlit_0_I14676000009897902695_assy765wm + 4), 0);

mem.setI32((strlit_0_I14676000009897902695_assy765wm + 8), 0);

mem.writeStr((strlit_0_I14676000009897902695_assy765wm + 12), "[Assertion Failure] ");

mem.setI32(strlit_0_I18337270522941735704_tok9e79hf, 4);

mem.setI32((strlit_0_I18337270522941735704_tok9e79hf + 4), 0);

mem.setI32((strlit_0_I18337270522941735704_tok9e79hf + 8), 0);

mem.writeStr((strlit_0_I18337270522941735704_tok9e79hf + 12), "bind");

mem.setI32(strlit_0_I11374605019106816382_tok9e79hf, 9);

mem.setI32((strlit_0_I11374605019106816382_tok9e79hf + 4), 0);

mem.setI32((strlit_0_I11374605019106816382_tok9e79hf + 8), 0);

mem.writeStr((strlit_0_I11374605019106816382_tok9e79hf + 12), "interface");

mem.setI32(strlit_0_I6669728318263290480_tok9e79hf, 5);

mem.setI32((strlit_0_I6669728318263290480_tok9e79hf + 4), 0);

mem.setI32((strlit_0_I6669728318263290480_tok9e79hf + 8), 0);

mem.writeStr((strlit_0_I6669728318263290480_tok9e79hf + 12), "mixin");

mem.setI32(strlit_0_I15803870852433253359_tok9e79hf, 5);

mem.setI32((strlit_0_I15803870852433253359_tok9e79hf + 4), 0);

mem.setI32((strlit_0_I15803870852433253359_tok9e79hf + 8), 0);

mem.writeStr((strlit_0_I15803870852433253359_tok9e79hf + 12), "using");

mem.copy(Keywords_0_tok9e79hf, (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1684300286);
  mem.setU32((_o + 4), strlit_0_I9557201018976274010_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 8), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1684955395);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 16), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 7561474);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 24), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1836278019);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 32), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1852400382);
  mem.setU32((_o + 4), strlit_0_I18337270522941735704_tok9e79hf);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 40), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1869374206);
  mem.setU32((_o + 4), strlit_0_I9830314142150548690_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 48), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1701995262);
  mem.setU32((_o + 4), strlit_0_I8380221545607033154_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 56), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1935762430);
  mem.setU32((_o + 4), strlit_0_I4956278306908871092_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 64), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1935762430);
  mem.setU32((_o + 4), strlit_0_I13909093427330098489_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 72), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1852793854);
  mem.setU32((_o + 4), strlit_0_I2544717250931810611_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 80), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1852793854);
  mem.setU32((_o + 4), strlit_0_I12999086881046019782_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 88), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1852793854);
  mem.setU32((_o + 4), strlit_0_I2210116261907819816_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 96), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1852793854);
  mem.setU32((_o + 4), strlit_0_I6864681898360807206_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 104), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1717921022);
  mem.setU32((_o + 4), strlit_0_I4167773820130397069_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 112), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1936286974);
  mem.setU32((_o + 4), strlit_0_I2956720964102846418_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 120), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1936286974);
  mem.setU32((_o + 4), strlit_0_I3021806080610957510_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 128), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1986618371);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 136), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 7300098);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 144), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1768711678);
  mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 152), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1936483838);
  mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 160), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1684956419);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 168), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1970169342);
  mem.setU32((_o + 4), strlit_0_I10462096440466995513_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 176), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1668834814);
  mem.setU32((_o + 4), strlit_0_I16264910594287870354_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 184), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1886938622);
  mem.setU32((_o + 4), strlit_0_I6313045265747232047_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 192), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1852401406);
  mem.setU32((_o + 4), strlit_0_I18082762212279024255_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 200), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1919903235);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 208), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1869768446);
  mem.setU32((_o + 4), strlit_0_I15371509460875483150_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 216), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1853187838);
  mem.setU32((_o + 4), strlit_0_I9991102891510134496_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 224), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 6711554);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 232), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1886218750);
  mem.setU32((_o + 4), strlit_0_I10578126245728228512_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 240), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 7235842);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 248), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1668180478);
  mem.setU32((_o + 4), strlit_0_I3312144845751804851_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 256), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1953393150);
  mem.setU32((_o + 4), strlit_0_I11374605019106816382_tok9e79hf);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 264), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 7563522);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 272), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1853057534);
  mem.setU32((_o + 4), strlit_0_I18205123775845960279_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 280), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1702128126);
  mem.setU32((_o + 4), strlit_0_I9071657656589967445_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 288), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1952803843);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 296), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1667329534);
  mem.setU32((_o + 4), strlit_0_I3777428167486794959_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 304), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1952804350);
  mem.setU32((_o + 4), strlit_0_I6517805684605582485_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 312), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 2020175358);
  mem.setU32((_o + 4), strlit_0_I6669728318263290480_tok9e79hf);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 320), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1685024003);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 328), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1818848771);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 336), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1953459715);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 344), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1953459966);
  mem.setU32((_o + 4), strlit_0_I17352810006323012799_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 352), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1784836094);
  mem.setU32((_o + 4), strlit_0_I973692718279674627_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 360), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 6713090);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 368), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 7499522);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 376), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1953853187);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 384), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1869771006);
  mem.setU32((_o + 4), strlit_0_I5316556160589403975_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 392), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1920233475);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 400), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1767994110);
  mem.setU32((_o + 4), strlit_0_I6137881024046402116_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 408), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1717924355);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 416), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1952805630);
  mem.setU32((_o + 4), strlit_0_I12427448230105600699_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 424), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1818784515);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 432), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1919447811);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 440), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1635021822);
  mem.setU32((_o + 4), strlit_0_I17569086427026686584_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 448), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1835365630);
  mem.setU32((_o + 4), strlit_0_I17987658270787974407_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 456), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 2037543939);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 464), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1886745854);
  mem.setU32((_o + 4), strlit_0_I18086024188298164462_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 472), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1887007998);
  mem.setU32((_o + 4), strlit_0_I13413619771642637377_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 480), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1769174526);
  mem.setU32((_o + 4), strlit_0_I15803870852433253359_tok9e79hf);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 488), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1918989827);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 496), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1701345278);
  mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 504), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1768454142);
  mem.setU32((_o + 4), strlit_0_I13200118161122656888_parq39nt2);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 512), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1919907843);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((Keywords_0_tok9e79hf + 520), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 1701411326);
  mem.setU32((_o + 4), strlit_0_I16137783760080910327_parq39nt2);
  return _o;
})(), 8);

mem.setI32(strlit_0_I8436252750452789659_websvfj9k1, 27);

mem.setI32((strlit_0_I8436252750452789659_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I8436252750452789659_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I8436252750452789659_websvfj9k1 + 12), "unterminated string literal");

mem.setI32(strlit_0_I7436273935627428487_websvfj9k1, 33);

mem.setI32((strlit_0_I7436273935627428487_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I7436273935627428487_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I7436273935627428487_websvfj9k1 + 12), "unterminated triple-quoted string");

mem.setI32(strlit_0_I14740933442681856299_websvfj9k1, 37);

mem.setI32((strlit_0_I14740933442681856299_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I14740933442681856299_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I14740933442681856299_websvfj9k1 + 12), "unterminated raw triple-quoted string");

mem.setI32(strlit_0_I5838082098074422888_websvfj9k1, 31);

mem.setI32((strlit_0_I5838082098074422888_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I5838082098074422888_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I5838082098074422888_websvfj9k1 + 12), "unterminated raw string literal");

mem.setI32(strlit_0_I11780787593763197124_websvfj9k1, 30);

mem.setI32((strlit_0_I11780787593763197124_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I11780787593763197124_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I11780787593763197124_websvfj9k1 + 12), "unterminated character literal");

mem.setI32(strlit_0_I12890960710833486046_websvfj9k1, 30);

mem.setI32((strlit_0_I12890960710833486046_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I12890960710833486046_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I12890960710833486046_websvfj9k1 + 12), "unclosed block comment '#[ ]#'");

mem.setI32(strlit_0_I15867609858545661460_websvfj9k1, 30);

mem.setI32((strlit_0_I15867609858545661460_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I15867609858545661460_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I15867609858545661460_websvfj9k1 + 12), "unclosed doc comment '##[ ]##'");

mem.setI32(strlit_0_I17451209550239811446_websvfj9k1, 4);

mem.setI32((strlit_0_I17451209550239811446_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I17451209550239811446_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I17451209550239811446_websvfj9k1 + 12), "'()'");

mem.setI32(strlit_0_I621061182478469467_websvfj9k1, 4);

mem.setI32((strlit_0_I621061182478469467_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I621061182478469467_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I621061182478469467_websvfj9k1 + 12), "'[]'");

mem.setI32(strlit_0_I15160080286962768302_websvfj9k1, 4);

mem.setI32((strlit_0_I15160080286962768302_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I15160080286962768302_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I15160080286962768302_websvfj9k1 + 12), "'{}'");

mem.setI32(strlit_0_I16111832319537461242_websvfj9k1, 18);

mem.setI32((strlit_0_I16111832319537461242_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I16111832319537461242_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I16111832319537461242_websvfj9k1 + 12), "unmatched closing ");

mem.setI32(strlit_0_I2791062431570189588_websvfj9k1, 20);

mem.setI32((strlit_0_I2791062431570189588_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I2791062431570189588_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I2791062431570189588_websvfj9k1 + 12), "mismatched bracket: ");

mem.setI32(strlit_0_I5340874533979027814_websvfj9k1, 11);

mem.setI32((strlit_0_I5340874533979027814_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I5340874533979027814_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I5340874533979027814_websvfj9k1 + 12), " opened at ");

mem.setI32(strlit_0_I13544407097396288341_websvfj9k1, 11);

mem.setI32((strlit_0_I13544407097396288341_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I13544407097396288341_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I13544407097396288341_websvfj9k1 + 12), " closed by ");

mem.setI32(strlit_0_I7528375458768032574_websvfj9k1, 9);

mem.setI32((strlit_0_I7528375458768032574_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I7528375458768032574_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I7528375458768032574_websvfj9k1 + 12), "unclosed ");

mem.setI32(strlit_0_I17487054685970555778_websvfj9k1, 75);

mem.setI32((strlit_0_I17487054685970555778_websvfj9k1 + 4), 0);

mem.setI32((strlit_0_I17487054685970555778_websvfj9k1 + 8), 0);

mem.writeStr((strlit_0_I17487054685970555778_websvfj9k1 + 12), "../nimony/lib/std/system/seqimpl.nim(256, 32): 0 < s.len [AssertionDefect]\n");

mem.setI32(strlit_0_I6105018409752412263_webzywwor1, 16);

mem.setI32((strlit_0_I6105018409752412263_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6105018409752412263_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6105018409752412263_webzywwor1 + 12), "0123456789abcdef");

mem.setI32(strlit_0_I4645790987703279553_webzywwor1, 4);

mem.setI32((strlit_0_I4645790987703279553_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I4645790987703279553_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I4645790987703279553_webzywwor1 + 12), "\\u00");

mem.setI32(strlit_0_I1077588883665121262_webzywwor1, 8);

mem.setI32((strlit_0_I1077588883665121262_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I1077588883665121262_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I1077588883665121262_webzywwor1 + 12), "{\"line\":");

mem.setI32(strlit_0_I7115103054454119625_webzywwor1, 7);

mem.setI32((strlit_0_I7115103054454119625_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I7115103054454119625_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I7115103054454119625_webzywwor1 + 12), ",\"col\":");

mem.setI32(strlit_0_I8163788669936926653_webzywwor1, 12);

mem.setI32((strlit_0_I8163788669936926653_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I8163788669936926653_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I8163788669936926653_webzywwor1 + 12), ",\"message\":\"");

mem.setI32(strlit_0_I16858515255358452405_webzywwor1, 8);

mem.setI32((strlit_0_I16858515255358452405_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I16858515255358452405_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I16858515255358452405_webzywwor1 + 12), "__np_src");

mem.setI32(strlit_0_I9665133714172714337_webzywwor1, 9);

mem.setI32((strlit_0_I9665133714172714337_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I9665133714172714337_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I9665133714172714337_webzywwor1 + 12), "__np_file");

mem.setI32(strlit_0_I12157574297857663135_webzywwor1, 6);

mem.setI32((strlit_0_I12157574297857663135_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I12157574297857663135_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I12157574297857663135_webzywwor1 + 12), "in.nim");

mem.setI32(strlit_0_I12129343431845544526_webzywwor1, 10);

mem.setI32((strlit_0_I12129343431845544526_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I12129343431845544526_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I12129343431845544526_webzywwor1 + 12), "__np_curly");

mem.setI32(strlit_0_I16664880105326712979_webzywwor1, 10);

mem.setI32((strlit_0_I16664880105326712979_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I16664880105326712979_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I16664880105326712979_webzywwor1 + 12), "globalThis");

mem.setI32(strlit_0_I7810566879425797473_webzywwor1, 8);

mem.setI32((strlit_0_I7810566879425797473_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I7810566879425797473_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I7810566879425797473_webzywwor1 + 12), "__np_out");

mem.setI32(strlit_0_I6187027680374537400_webzywwor1, 9);

mem.setI32((strlit_0_I6187027680374537400_webzywwor1 + 4), 0);

mem.setI32((strlit_0_I6187027680374537400_webzywwor1 + 8), 0);

mem.writeStr((strlit_0_I6187027680374537400_webzywwor1 + 12), "__np_diag");

mem.setI32(strlit_0_I15750996627617194403_cmdqs323n1, 19);

mem.setI32((strlit_0_I15750996627617194403_cmdqs323n1 + 4), 0);

mem.setI32((strlit_0_I15750996627617194403_cmdqs323n1 + 8), 0);

mem.writeStr((strlit_0_I15750996627617194403_cmdqs323n1 + 12), "leave uninitialized");

mem.setI32(strlit_0_I14131790745264837101_sysvq0asl, 90);

mem.setI32((strlit_0_I14131790745264837101_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I14131790745264837101_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I14131790745264837101_sysvq0asl + 12), "../nimony/lib/std/system/stringimpl.nim(403, 37): i < len(s) and 0 <= i [AssertionDefect]\n");

mem.setI32(strlit_0_I11927585966806674622_sysvq0asl, 90);

mem.setI32((strlit_0_I11927585966806674622_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I11927585966806674622_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I11927585966806674622_sysvq0asl + 12), "../nimony/lib/std/system/stringimpl.nim(407, 45): i < len(s) and 0 <= i [AssertionDefect]\n");

mem.setI32(strlit_0_I15539159382304113184_sysvq0asl, 27);

mem.setI32((strlit_0_I15539159382304113184_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I15539159382304113184_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I15539159382304113184_sysvq0asl + 12), "invalid object conversion: ");

mem.setI32(strlit_0_I14281474217946372742_sysvq0asl, 35);

mem.setI32((strlit_0_I14281474217946372742_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I14281474217946372742_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I14281474217946372742_sysvq0asl + 12), "cannot dispatch; dispatcher is nil\n");

mem.setI32(strlit_0_I16690852185662743073_sysvq0asl, 16);

mem.setI32((strlit_0_I16690852185662743073_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I16690852185662743073_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I16690852185662743073_sysvq0asl + 12), "could not load: ");

mem.setI32(strlit_0_I10604297744791418982_sysvq0asl, 18);

mem.setI32((strlit_0_I10604297744791418982_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I10604297744791418982_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I10604297744791418982_sysvq0asl + 12), "could not import: ");

mem.setI32(strlit_0_I11614695157650328859_sysvq0asl, 21);

mem.setI32((strlit_0_I11614695157650328859_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I11614695157650328859_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I11614695157650328859_sysvq0asl + 12), "index out of bounds: ");

mem.setI32(strlit_0_I16845119709590674135_sysvq0asl, 7);

mem.setI32((strlit_0_I16845119709590674135_sysvq0asl + 4), 0);

mem.setI32((strlit_0_I16845119709590674135_sysvq0asl + 8), 0);

mem.writeStr((strlit_0_I16845119709590674135_sysvq0asl + 12), " notin ");

mem.copy(NegTen_0_sysvq0asl, (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3157250);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 8), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3222786);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 16), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3288322);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 24), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3353858);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 32), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3419394);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 40), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3484930);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 48), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3550466);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 56), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3616002);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 64), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3681538);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.copy((NegTen_0_sysvq0asl + 72), (() => {
  let _o = allocFixed(8);
  mem.setU32(_o, 3747074);
  mem.setU32((_o + 4), 0);
  return _o;
})(), 8);

mem.setI8(fsLookupTable_0_sysvq0asl, -1);

mem.setI8((fsLookupTable_0_sysvq0asl + 1), 0);

mem.setI8((fsLookupTable_0_sysvq0asl + 2), 1);

mem.setI8((fsLookupTable_0_sysvq0asl + 3), 1);

mem.setI8((fsLookupTable_0_sysvq0asl + 4), 2);

mem.setI8((fsLookupTable_0_sysvq0asl + 5), 2);

mem.setI8((fsLookupTable_0_sysvq0asl + 6), 2);

mem.setI8((fsLookupTable_0_sysvq0asl + 7), 2);

mem.setI8((fsLookupTable_0_sysvq0asl + 8), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 9), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 10), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 11), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 12), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 13), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 14), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 15), 3);

mem.setI8((fsLookupTable_0_sysvq0asl + 16), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 17), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 18), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 19), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 20), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 21), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 22), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 23), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 24), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 25), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 26), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 27), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 28), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 29), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 30), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 31), 4);

mem.setI8((fsLookupTable_0_sysvq0asl + 32), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 33), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 34), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 35), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 36), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 37), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 38), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 39), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 40), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 41), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 42), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 43), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 44), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 45), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 46), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 47), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 48), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 49), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 50), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 51), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 52), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 53), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 54), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 55), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 56), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 57), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 58), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 59), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 60), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 61), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 62), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 63), 5);

mem.setI8((fsLookupTable_0_sysvq0asl + 64), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 65), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 66), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 67), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 68), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 69), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 70), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 71), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 72), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 73), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 74), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 75), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 76), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 77), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 78), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 79), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 80), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 81), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 82), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 83), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 84), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 85), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 86), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 87), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 88), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 89), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 90), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 91), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 92), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 93), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 94), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 95), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 96), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 97), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 98), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 99), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 100), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 101), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 102), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 103), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 104), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 105), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 106), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 107), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 108), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 109), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 110), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 111), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 112), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 113), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 114), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 115), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 116), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 117), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 118), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 119), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 120), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 121), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 122), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 123), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 124), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 125), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 126), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 127), 6);

mem.setI8((fsLookupTable_0_sysvq0asl + 128), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 129), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 130), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 131), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 132), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 133), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 134), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 135), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 136), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 137), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 138), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 139), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 140), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 141), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 142), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 143), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 144), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 145), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 146), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 147), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 148), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 149), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 150), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 151), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 152), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 153), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 154), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 155), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 156), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 157), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 158), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 159), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 160), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 161), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 162), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 163), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 164), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 165), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 166), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 167), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 168), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 169), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 170), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 171), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 172), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 173), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 174), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 175), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 176), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 177), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 178), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 179), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 180), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 181), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 182), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 183), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 184), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 185), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 186), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 187), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 188), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 189), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 190), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 191), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 192), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 193), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 194), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 195), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 196), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 197), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 198), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 199), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 200), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 201), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 202), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 203), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 204), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 205), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 206), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 207), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 208), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 209), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 210), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 211), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 212), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 213), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 214), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 215), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 216), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 217), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 218), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 219), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 220), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 221), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 222), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 223), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 224), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 225), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 226), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 227), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 228), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 229), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 230), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 231), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 232), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 233), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 234), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 235), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 236), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 237), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 238), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 239), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 240), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 241), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 242), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 243), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 244), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 245), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 246), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 247), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 248), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 249), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 250), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 251), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 252), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 253), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 254), 7);

mem.setI8((fsLookupTable_0_sysvq0asl + 255), 7);

mem.setI8(trailingZeros100_0_sysvq0asl, 2);

mem.setI8((trailingZeros100_0_sysvq0asl + 1), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 2), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 3), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 4), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 5), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 6), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 7), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 8), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 9), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 10), 1);

mem.setI8((trailingZeros100_0_sysvq0asl + 11), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 12), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 13), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 14), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 15), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 16), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 17), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 18), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 19), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 20), 1);

mem.setI8((trailingZeros100_0_sysvq0asl + 21), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 22), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 23), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 24), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 25), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 26), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 27), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 28), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 29), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 30), 1);

mem.setI8((trailingZeros100_0_sysvq0asl + 31), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 32), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 33), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 34), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 35), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 36), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 37), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 38), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 39), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 40), 1);

mem.setI8((trailingZeros100_0_sysvq0asl + 41), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 42), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 43), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 44), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 45), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 46), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 47), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 48), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 49), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 50), 1);

mem.setI8((trailingZeros100_0_sysvq0asl + 51), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 52), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 53), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 54), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 55), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 56), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 57), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 58), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 59), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 60), 1);

mem.setI8((trailingZeros100_0_sysvq0asl + 61), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 62), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 63), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 64), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 65), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 66), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 67), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 68), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 69), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 70), 1);

mem.setI8((trailingZeros100_0_sysvq0asl + 71), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 72), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 73), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 74), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 75), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 76), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 77), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 78), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 79), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 80), 1);

mem.setI8((trailingZeros100_0_sysvq0asl + 81), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 82), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 83), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 84), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 85), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 86), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 87), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 88), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 89), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 90), 1);

mem.setI8((trailingZeros100_0_sysvq0asl + 91), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 92), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 93), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 94), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 95), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 96), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 97), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 98), 0);

mem.setI8((trailingZeros100_0_sysvq0asl + 99), 0);

mem.setU8(digits100_0_sysvq0asl, 48);

mem.setU8((digits100_0_sysvq0asl + 1), 48);

mem.setU8((digits100_0_sysvq0asl + 2), 48);

mem.setU8((digits100_0_sysvq0asl + 3), 49);

mem.setU8((digits100_0_sysvq0asl + 4), 48);

mem.setU8((digits100_0_sysvq0asl + 5), 50);

mem.setU8((digits100_0_sysvq0asl + 6), 48);

mem.setU8((digits100_0_sysvq0asl + 7), 51);

mem.setU8((digits100_0_sysvq0asl + 8), 48);

mem.setU8((digits100_0_sysvq0asl + 9), 52);

mem.setU8((digits100_0_sysvq0asl + 10), 48);

mem.setU8((digits100_0_sysvq0asl + 11), 53);

mem.setU8((digits100_0_sysvq0asl + 12), 48);

mem.setU8((digits100_0_sysvq0asl + 13), 54);

mem.setU8((digits100_0_sysvq0asl + 14), 48);

mem.setU8((digits100_0_sysvq0asl + 15), 55);

mem.setU8((digits100_0_sysvq0asl + 16), 48);

mem.setU8((digits100_0_sysvq0asl + 17), 56);

mem.setU8((digits100_0_sysvq0asl + 18), 48);

mem.setU8((digits100_0_sysvq0asl + 19), 57);

mem.setU8((digits100_0_sysvq0asl + 20), 49);

mem.setU8((digits100_0_sysvq0asl + 21), 48);

mem.setU8((digits100_0_sysvq0asl + 22), 49);

mem.setU8((digits100_0_sysvq0asl + 23), 49);

mem.setU8((digits100_0_sysvq0asl + 24), 49);

mem.setU8((digits100_0_sysvq0asl + 25), 50);

mem.setU8((digits100_0_sysvq0asl + 26), 49);

mem.setU8((digits100_0_sysvq0asl + 27), 51);

mem.setU8((digits100_0_sysvq0asl + 28), 49);

mem.setU8((digits100_0_sysvq0asl + 29), 52);

mem.setU8((digits100_0_sysvq0asl + 30), 49);

mem.setU8((digits100_0_sysvq0asl + 31), 53);

mem.setU8((digits100_0_sysvq0asl + 32), 49);

mem.setU8((digits100_0_sysvq0asl + 33), 54);

mem.setU8((digits100_0_sysvq0asl + 34), 49);

mem.setU8((digits100_0_sysvq0asl + 35), 55);

mem.setU8((digits100_0_sysvq0asl + 36), 49);

mem.setU8((digits100_0_sysvq0asl + 37), 56);

mem.setU8((digits100_0_sysvq0asl + 38), 49);

mem.setU8((digits100_0_sysvq0asl + 39), 57);

mem.setU8((digits100_0_sysvq0asl + 40), 50);

mem.setU8((digits100_0_sysvq0asl + 41), 48);

mem.setU8((digits100_0_sysvq0asl + 42), 50);

mem.setU8((digits100_0_sysvq0asl + 43), 49);

mem.setU8((digits100_0_sysvq0asl + 44), 50);

mem.setU8((digits100_0_sysvq0asl + 45), 50);

mem.setU8((digits100_0_sysvq0asl + 46), 50);

mem.setU8((digits100_0_sysvq0asl + 47), 51);

mem.setU8((digits100_0_sysvq0asl + 48), 50);

mem.setU8((digits100_0_sysvq0asl + 49), 52);

mem.setU8((digits100_0_sysvq0asl + 50), 50);

mem.setU8((digits100_0_sysvq0asl + 51), 53);

mem.setU8((digits100_0_sysvq0asl + 52), 50);

mem.setU8((digits100_0_sysvq0asl + 53), 54);

mem.setU8((digits100_0_sysvq0asl + 54), 50);

mem.setU8((digits100_0_sysvq0asl + 55), 55);

mem.setU8((digits100_0_sysvq0asl + 56), 50);

mem.setU8((digits100_0_sysvq0asl + 57), 56);

mem.setU8((digits100_0_sysvq0asl + 58), 50);

mem.setU8((digits100_0_sysvq0asl + 59), 57);

mem.setU8((digits100_0_sysvq0asl + 60), 51);

mem.setU8((digits100_0_sysvq0asl + 61), 48);

mem.setU8((digits100_0_sysvq0asl + 62), 51);

mem.setU8((digits100_0_sysvq0asl + 63), 49);

mem.setU8((digits100_0_sysvq0asl + 64), 51);

mem.setU8((digits100_0_sysvq0asl + 65), 50);

mem.setU8((digits100_0_sysvq0asl + 66), 51);

mem.setU8((digits100_0_sysvq0asl + 67), 51);

mem.setU8((digits100_0_sysvq0asl + 68), 51);

mem.setU8((digits100_0_sysvq0asl + 69), 52);

mem.setU8((digits100_0_sysvq0asl + 70), 51);

mem.setU8((digits100_0_sysvq0asl + 71), 53);

mem.setU8((digits100_0_sysvq0asl + 72), 51);

mem.setU8((digits100_0_sysvq0asl + 73), 54);

mem.setU8((digits100_0_sysvq0asl + 74), 51);

mem.setU8((digits100_0_sysvq0asl + 75), 55);

mem.setU8((digits100_0_sysvq0asl + 76), 51);

mem.setU8((digits100_0_sysvq0asl + 77), 56);

mem.setU8((digits100_0_sysvq0asl + 78), 51);

mem.setU8((digits100_0_sysvq0asl + 79), 57);

mem.setU8((digits100_0_sysvq0asl + 80), 52);

mem.setU8((digits100_0_sysvq0asl + 81), 48);

mem.setU8((digits100_0_sysvq0asl + 82), 52);

mem.setU8((digits100_0_sysvq0asl + 83), 49);

mem.setU8((digits100_0_sysvq0asl + 84), 52);

mem.setU8((digits100_0_sysvq0asl + 85), 50);

mem.setU8((digits100_0_sysvq0asl + 86), 52);

mem.setU8((digits100_0_sysvq0asl + 87), 51);

mem.setU8((digits100_0_sysvq0asl + 88), 52);

mem.setU8((digits100_0_sysvq0asl + 89), 52);

mem.setU8((digits100_0_sysvq0asl + 90), 52);

mem.setU8((digits100_0_sysvq0asl + 91), 53);

mem.setU8((digits100_0_sysvq0asl + 92), 52);

mem.setU8((digits100_0_sysvq0asl + 93), 54);

mem.setU8((digits100_0_sysvq0asl + 94), 52);

mem.setU8((digits100_0_sysvq0asl + 95), 55);

mem.setU8((digits100_0_sysvq0asl + 96), 52);

mem.setU8((digits100_0_sysvq0asl + 97), 56);

mem.setU8((digits100_0_sysvq0asl + 98), 52);

mem.setU8((digits100_0_sysvq0asl + 99), 57);

mem.setU8((digits100_0_sysvq0asl + 100), 53);

mem.setU8((digits100_0_sysvq0asl + 101), 48);

mem.setU8((digits100_0_sysvq0asl + 102), 53);

mem.setU8((digits100_0_sysvq0asl + 103), 49);

mem.setU8((digits100_0_sysvq0asl + 104), 53);

mem.setU8((digits100_0_sysvq0asl + 105), 50);

mem.setU8((digits100_0_sysvq0asl + 106), 53);

mem.setU8((digits100_0_sysvq0asl + 107), 51);

mem.setU8((digits100_0_sysvq0asl + 108), 53);

mem.setU8((digits100_0_sysvq0asl + 109), 52);

mem.setU8((digits100_0_sysvq0asl + 110), 53);

mem.setU8((digits100_0_sysvq0asl + 111), 53);

mem.setU8((digits100_0_sysvq0asl + 112), 53);

mem.setU8((digits100_0_sysvq0asl + 113), 54);

mem.setU8((digits100_0_sysvq0asl + 114), 53);

mem.setU8((digits100_0_sysvq0asl + 115), 55);

mem.setU8((digits100_0_sysvq0asl + 116), 53);

mem.setU8((digits100_0_sysvq0asl + 117), 56);

mem.setU8((digits100_0_sysvq0asl + 118), 53);

mem.setU8((digits100_0_sysvq0asl + 119), 57);

mem.setU8((digits100_0_sysvq0asl + 120), 54);

mem.setU8((digits100_0_sysvq0asl + 121), 48);

mem.setU8((digits100_0_sysvq0asl + 122), 54);

mem.setU8((digits100_0_sysvq0asl + 123), 49);

mem.setU8((digits100_0_sysvq0asl + 124), 54);

mem.setU8((digits100_0_sysvq0asl + 125), 50);

mem.setU8((digits100_0_sysvq0asl + 126), 54);

mem.setU8((digits100_0_sysvq0asl + 127), 51);

mem.setU8((digits100_0_sysvq0asl + 128), 54);

mem.setU8((digits100_0_sysvq0asl + 129), 52);

mem.setU8((digits100_0_sysvq0asl + 130), 54);

mem.setU8((digits100_0_sysvq0asl + 131), 53);

mem.setU8((digits100_0_sysvq0asl + 132), 54);

mem.setU8((digits100_0_sysvq0asl + 133), 54);

mem.setU8((digits100_0_sysvq0asl + 134), 54);

mem.setU8((digits100_0_sysvq0asl + 135), 55);

mem.setU8((digits100_0_sysvq0asl + 136), 54);

mem.setU8((digits100_0_sysvq0asl + 137), 56);

mem.setU8((digits100_0_sysvq0asl + 138), 54);

mem.setU8((digits100_0_sysvq0asl + 139), 57);

mem.setU8((digits100_0_sysvq0asl + 140), 55);

mem.setU8((digits100_0_sysvq0asl + 141), 48);

mem.setU8((digits100_0_sysvq0asl + 142), 55);

mem.setU8((digits100_0_sysvq0asl + 143), 49);

mem.setU8((digits100_0_sysvq0asl + 144), 55);

mem.setU8((digits100_0_sysvq0asl + 145), 50);

mem.setU8((digits100_0_sysvq0asl + 146), 55);

mem.setU8((digits100_0_sysvq0asl + 147), 51);

mem.setU8((digits100_0_sysvq0asl + 148), 55);

mem.setU8((digits100_0_sysvq0asl + 149), 52);

mem.setU8((digits100_0_sysvq0asl + 150), 55);

mem.setU8((digits100_0_sysvq0asl + 151), 53);

mem.setU8((digits100_0_sysvq0asl + 152), 55);

mem.setU8((digits100_0_sysvq0asl + 153), 54);

mem.setU8((digits100_0_sysvq0asl + 154), 55);

mem.setU8((digits100_0_sysvq0asl + 155), 55);

mem.setU8((digits100_0_sysvq0asl + 156), 55);

mem.setU8((digits100_0_sysvq0asl + 157), 56);

mem.setU8((digits100_0_sysvq0asl + 158), 55);

mem.setU8((digits100_0_sysvq0asl + 159), 57);

mem.setU8((digits100_0_sysvq0asl + 160), 56);

mem.setU8((digits100_0_sysvq0asl + 161), 48);

mem.setU8((digits100_0_sysvq0asl + 162), 56);

mem.setU8((digits100_0_sysvq0asl + 163), 49);

mem.setU8((digits100_0_sysvq0asl + 164), 56);

mem.setU8((digits100_0_sysvq0asl + 165), 50);

mem.setU8((digits100_0_sysvq0asl + 166), 56);

mem.setU8((digits100_0_sysvq0asl + 167), 51);

mem.setU8((digits100_0_sysvq0asl + 168), 56);

mem.setU8((digits100_0_sysvq0asl + 169), 52);

mem.setU8((digits100_0_sysvq0asl + 170), 56);

mem.setU8((digits100_0_sysvq0asl + 171), 53);

mem.setU8((digits100_0_sysvq0asl + 172), 56);

mem.setU8((digits100_0_sysvq0asl + 173), 54);

mem.setU8((digits100_0_sysvq0asl + 174), 56);

mem.setU8((digits100_0_sysvq0asl + 175), 55);

mem.setU8((digits100_0_sysvq0asl + 176), 56);

mem.setU8((digits100_0_sysvq0asl + 177), 56);

mem.setU8((digits100_0_sysvq0asl + 178), 56);

mem.setU8((digits100_0_sysvq0asl + 179), 57);

mem.setU8((digits100_0_sysvq0asl + 180), 57);

mem.setU8((digits100_0_sysvq0asl + 181), 48);

mem.setU8((digits100_0_sysvq0asl + 182), 57);

mem.setU8((digits100_0_sysvq0asl + 183), 49);

mem.setU8((digits100_0_sysvq0asl + 184), 57);

mem.setU8((digits100_0_sysvq0asl + 185), 50);

mem.setU8((digits100_0_sysvq0asl + 186), 57);

mem.setU8((digits100_0_sysvq0asl + 187), 51);

mem.setU8((digits100_0_sysvq0asl + 188), 57);

mem.setU8((digits100_0_sysvq0asl + 189), 52);

mem.setU8((digits100_0_sysvq0asl + 190), 57);

mem.setU8((digits100_0_sysvq0asl + 191), 53);

mem.setU8((digits100_0_sysvq0asl + 192), 57);

mem.setU8((digits100_0_sysvq0asl + 193), 54);

mem.setU8((digits100_0_sysvq0asl + 194), 57);

mem.setU8((digits100_0_sysvq0asl + 195), 55);

mem.setU8((digits100_0_sysvq0asl + 196), 57);

mem.setU8((digits100_0_sysvq0asl + 197), 56);

mem.setU8((digits100_0_sysvq0asl + 198), 57);

mem.setU8((digits100_0_sysvq0asl + 199), 57);

mem.setI32(strlit_0_I14694606176902936784_has9tn57v, 92);

mem.setI32((strlit_0_I14694606176902936784_has9tn57v + 4), 0);

mem.setI32((strlit_0_I14694606176902936784_has9tn57v + 8), 0);

mem.writeStr((strlit_0_I14694606176902936784_has9tn57v + 12), "../nimony/lib/std/system/openarrays.nim(10, 49): 0 <= idx and idx < x.len [AssertionDefect]\n");
// generated by lengc (js backend) from osalirkw71.c.nif

function len_6_Igv2wyu1_osalirkw71(a_3) {
  let result_9;
  result_9 = mem.i32((a_3 + 4));
  return result_9;
}

function getQ_10_Ik9hgkq1_osalirkw71(x_4, idx_1) {
  let X60Qx_11;
  if ((0 <= idx_1)) {
    X60Qx_11 = (idx_1 < mem.i32((x_4 + 4)));
  } else {
    X60Qx_11 = false;
  }
  if ((!X60Qx_11)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14694606176902936784_has9tn57v);
      return _o;
    })());
  }
  let result_10;
  result_10 = (mem.u32(x_4) + (idx_1 * 8));
  return result_10;
}

let X60QiniGuard_0_osalirkw71 = allocFixed(1);

function X60Qini_0_osalirkw71() {
  if (mem.u8At(X60QiniGuard_0_osalirkw71)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_osalirkw71, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_envto7w6l1();
  X60Qini_0_ospaexnw61();
  X60Qini_0_ossk30t39();
}
// generated by lengc (js backend) from err0o7h081.c.nif

let X60QiniGuard_0_err0o7h081 = allocFixed(1);

function X60Qini_0_err0o7h081() {
  if (mem.u8At(X60QiniGuard_0_err0o7h081)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_err0o7h081, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from party5a2l1.c.nif

function parseBiggestFloat_0_party5a2l1(s_6, number_4) {
  whileStmtLabel_8: {
    whileStmtLabel_0: {
      var result_6;
      var IdentChars_0 = allocFixed(32);
      mem.setU8(IdentChars_0, 0);
      mem.setU8((IdentChars_0 + 1), 0);
      mem.setU8((IdentChars_0 + 2), 0);
      mem.setU8((IdentChars_0 + 3), 0);
      mem.setU8((IdentChars_0 + 4), 0);
      mem.setU8((IdentChars_0 + 5), 0);
      mem.setU8((IdentChars_0 + 6), 255);
      mem.setU8((IdentChars_0 + 7), 3);
      mem.setU8((IdentChars_0 + 8), 254);
      mem.setU8((IdentChars_0 + 9), 255);
      mem.setU8((IdentChars_0 + 10), 255);
      mem.setU8((IdentChars_0 + 11), 135);
      mem.setU8((IdentChars_0 + 12), 254);
      mem.setU8((IdentChars_0 + 13), 255);
      mem.setU8((IdentChars_0 + 14), 255);
      mem.setU8((IdentChars_0 + 15), 7);
      mem.setU8((IdentChars_0 + 16), 0);
      mem.setU8((IdentChars_0 + 17), 0);
      mem.setU8((IdentChars_0 + 18), 0);
      mem.setU8((IdentChars_0 + 19), 0);
      mem.setU8((IdentChars_0 + 20), 0);
      mem.setU8((IdentChars_0 + 21), 0);
      mem.setU8((IdentChars_0 + 22), 0);
      mem.setU8((IdentChars_0 + 23), 0);
      mem.setU8((IdentChars_0 + 24), 0);
      mem.setU8((IdentChars_0 + 25), 0);
      mem.setU8((IdentChars_0 + 26), 0);
      mem.setU8((IdentChars_0 + 27), 0);
      mem.setU8((IdentChars_0 + 28), 0);
      mem.setU8((IdentChars_0 + 29), 0);
      mem.setU8((IdentChars_0 + 30), 0);
      mem.setU8((IdentChars_0 + 31), 0);
      var powtens_0 = allocFixed(184);
      mem.setF64(powtens_0, 1.0);
      mem.setF64((powtens_0 + 8), 10.0);
      mem.setF64((powtens_0 + 16), 100.0);
      mem.setF64((powtens_0 + 24), 1000.0);
      mem.setF64((powtens_0 + 32), 10000.0);
      mem.setF64((powtens_0 + 40), 100000.0);
      mem.setF64((powtens_0 + 48), 1000000.0);
      mem.setF64((powtens_0 + 56), 10000000.0);
      mem.setF64((powtens_0 + 64), 100000000.0);
      mem.setF64((powtens_0 + 72), 1000000000.0);
      mem.setF64((powtens_0 + 80), 10000000000.0);
      mem.setF64((powtens_0 + 88), 100000000000.0);
      mem.setF64((powtens_0 + 96), 1000000000000.0);
      mem.setF64((powtens_0 + 104), 10000000000000.0);
      mem.setF64((powtens_0 + 112), 100000000000000.0);
      mem.setF64((powtens_0 + 120), 1000000000000000.0);
      mem.setF64((powtens_0 + 128), 10000000000000000.0);
      mem.setF64((powtens_0 + 136), 1e+17);
      mem.setF64((powtens_0 + 144), 1e+18);
      mem.setF64((powtens_0 + 152), 1e+19);
      mem.setF64((powtens_0 + 160), 1e+20);
      mem.setF64((powtens_0 + 168), 1e+21);
      mem.setF64((powtens_0 + 176), 1e+22);
      var i_2 = allocFixed(4);
      mem.setI32(i_2, 0);
      var sign_1 = 1.0;
      var kdigits_0 = allocFixed(4);
      mem.setI32(kdigits_0, 0);
      var fdigits_0 = allocFixed(4);
      mem.setI32(fdigits_0, 0);
      var exponent_0 = 0;
      var integer_0 = 0n;
      var fracExponent_0 = allocFixed(4);
      mem.setI32(fracExponent_0, 0);
      var expSign_0 = 1;
      var firstDigit_0 = -1;
      var hasSign_0 = false;
      var X60Qx_51;
      var X60Qx_52 = len_6_Iroq7kd1_has9tn57v(s_6);
      if ((mem.i32(i_2) < X60Qx_52)) {
        var X60Qx_53;
        var X60Qx_54 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        if ((mem.u8At(X60Qx_54) === 43)) {
          X60Qx_53 = true;
        } else {
          var X60Qx_55 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          X60Qx_53 = (mem.u8At(X60Qx_55) === 45);
        }
        X60Qx_51 = X60Qx_53;
      } else {
        X60Qx_51 = false;
      }
      if (X60Qx_51) {
        hasSign_0 = true;
        var X60Qx_56 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        if ((mem.u8At(X60Qx_56) === 45)) {
          sign_1 = -1.0;
        }
        inc_1_I6wjjge_cmdqs323n1(i_2);
      }
      var X60Qx_57;
      var X60Qx_58 = len_6_Iroq7kd1_has9tn57v(s_6);
      if ((((mem.i32(i_2) + 2) | 0) < X60Qx_58)) {
        var X60Qx_59;
        var X60Qx_60 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        if ((mem.u8At(X60Qx_60) === 78)) {
          X60Qx_59 = true;
        } else {
          var X60Qx_61 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          X60Qx_59 = (mem.u8At(X60Qx_61) === 110);
        }
        X60Qx_57 = X60Qx_59;
      } else {
        X60Qx_57 = false;
      }
      if (X60Qx_57) {
        var X60Qx_62;
        var X60Qx_63 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 1) | 0));
        if ((mem.u8At(X60Qx_63) === 65)) {
          X60Qx_62 = true;
        } else {
          var X60Qx_64 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 1) | 0));
          X60Qx_62 = (mem.u8At(X60Qx_64) === 97);
        }
        if (X60Qx_62) {
          var X60Qx_65;
          var X60Qx_66 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 2) | 0));
          if ((mem.u8At(X60Qx_66) === 78)) {
            X60Qx_65 = true;
          } else {
            var X60Qx_67 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 2) | 0));
            X60Qx_65 = (mem.u8At(X60Qx_67) === 110);
          }
          if (X60Qx_65) {
            var X60Qx_6;
            if ((mem.i32((s_6 + 4)) <= ((mem.i32(i_2) + 3) | 0))) {
              X60Qx_6 = true;
            } else {
              var X60Qdesugar_12 = allocFixed(32);
              mem.copy(X60Qdesugar_12, IdentChars_0, 32);
              var X60Qx_68 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 3) | 0));
              var X60Qdesugar_13 = mem.u8At(X60Qx_68);
              X60Qx_6 = (!(((mem.u8At((X60Qdesugar_12 + (X60Qdesugar_13 >>> 3))) & ((1 << ((X60Qdesugar_13 & 7) >>> 0)) >>> 0)) >>> 0) !== 0));
            }
            if (X60Qx_6) {
              mem.setF64(number_4, NaN);
              result_6 = ((mem.i32(i_2) + 3) | 0);
              return result_6;
            }
          }
        }
        return 0;
      }
      var X60Qx_69;
      var X60Qx_70 = len_6_Iroq7kd1_has9tn57v(s_6);
      if ((((mem.i32(i_2) + 2) | 0) < X60Qx_70)) {
        var X60Qx_71;
        var X60Qx_72 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        if ((mem.u8At(X60Qx_72) === 73)) {
          X60Qx_71 = true;
        } else {
          var X60Qx_73 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          X60Qx_71 = (mem.u8At(X60Qx_73) === 105);
        }
        X60Qx_69 = X60Qx_71;
      } else {
        X60Qx_69 = false;
      }
      if (X60Qx_69) {
        var X60Qx_74;
        var X60Qx_75 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 1) | 0));
        if ((mem.u8At(X60Qx_75) === 78)) {
          X60Qx_74 = true;
        } else {
          var X60Qx_76 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 1) | 0));
          X60Qx_74 = (mem.u8At(X60Qx_76) === 110);
        }
        if (X60Qx_74) {
          var X60Qx_77;
          var X60Qx_78 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 2) | 0));
          if ((mem.u8At(X60Qx_78) === 70)) {
            X60Qx_77 = true;
          } else {
            var X60Qx_79 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 2) | 0));
            X60Qx_77 = (mem.u8At(X60Qx_79) === 102);
          }
          if (X60Qx_77) {
            var X60Qx_7;
            if ((mem.i32((s_6 + 4)) <= ((mem.i32(i_2) + 3) | 0))) {
              X60Qx_7 = true;
            } else {
              var X60Qdesugar_14 = allocFixed(32);
              mem.copy(X60Qdesugar_14, IdentChars_0, 32);
              var X60Qx_80 = getQ_10_I5nt6we_has9tn57v(s_6, ((mem.i32(i_2) + 3) | 0));
              var X60Qdesugar_15 = mem.u8At(X60Qx_80);
              X60Qx_7 = (!(((mem.u8At((X60Qdesugar_14 + (X60Qdesugar_15 >>> 3))) & ((1 << ((X60Qdesugar_15 & 7) >>> 0)) >>> 0)) >>> 0) !== 0));
            }
            if (X60Qx_7) {
              mem.setF64(number_4, (Infinity * sign_1));
              result_6 = ((mem.i32(i_2) + 3) | 0);
              return result_6;
            }
          }
        }
        return 0;
      }
      var X60Qx_8;
      var X60Qx_81 = len_6_Iroq7kd1_has9tn57v(s_6);
      if ((mem.i32(i_2) < X60Qx_81)) {
        var X60Qdesugar_16 = allocFixed(32);
        mem.setU8(X60Qdesugar_16, 0);
        mem.setU8((X60Qdesugar_16 + 1), 0);
        mem.setU8((X60Qdesugar_16 + 2), 0);
        mem.setU8((X60Qdesugar_16 + 3), 0);
        mem.setU8((X60Qdesugar_16 + 4), 0);
        mem.setU8((X60Qdesugar_16 + 5), 0);
        mem.setU8((X60Qdesugar_16 + 6), 255);
        mem.setU8((X60Qdesugar_16 + 7), 3);
        mem.setU8((X60Qdesugar_16 + 8), 0);
        mem.setU8((X60Qdesugar_16 + 9), 0);
        mem.setU8((X60Qdesugar_16 + 10), 0);
        mem.setU8((X60Qdesugar_16 + 11), 0);
        mem.setU8((X60Qdesugar_16 + 12), 0);
        mem.setU8((X60Qdesugar_16 + 13), 0);
        mem.setU8((X60Qdesugar_16 + 14), 0);
        mem.setU8((X60Qdesugar_16 + 15), 0);
        mem.setU8((X60Qdesugar_16 + 16), 0);
        mem.setU8((X60Qdesugar_16 + 17), 0);
        mem.setU8((X60Qdesugar_16 + 18), 0);
        mem.setU8((X60Qdesugar_16 + 19), 0);
        mem.setU8((X60Qdesugar_16 + 20), 0);
        mem.setU8((X60Qdesugar_16 + 21), 0);
        mem.setU8((X60Qdesugar_16 + 22), 0);
        mem.setU8((X60Qdesugar_16 + 23), 0);
        mem.setU8((X60Qdesugar_16 + 24), 0);
        mem.setU8((X60Qdesugar_16 + 25), 0);
        mem.setU8((X60Qdesugar_16 + 26), 0);
        mem.setU8((X60Qdesugar_16 + 27), 0);
        mem.setU8((X60Qdesugar_16 + 28), 0);
        mem.setU8((X60Qdesugar_16 + 29), 0);
        mem.setU8((X60Qdesugar_16 + 30), 0);
        mem.setU8((X60Qdesugar_16 + 31), 0);
        var X60Qx_82 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        var X60Qdesugar_17 = mem.u8At(X60Qx_82);
        X60Qx_8 = (((mem.u8At((X60Qdesugar_16 + (X60Qdesugar_17 >>> 3))) & ((1 << ((X60Qdesugar_17 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
      } else {
        X60Qx_8 = false;
      }
      if (X60Qx_8) {
        var X60Qx_83 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        firstDigit_0 = ((mem.u8At(X60Qx_83) - 48) | 0);
      }
      {
        while (true) {
          var X60Qx_9;
          var X60Qx_84 = len_6_Iroq7kd1_has9tn57v(s_6);
          if ((mem.i32(i_2) < X60Qx_84)) {
            var X60Qdesugar_18 = allocFixed(32);
            mem.setU8(X60Qdesugar_18, 0);
            mem.setU8((X60Qdesugar_18 + 1), 0);
            mem.setU8((X60Qdesugar_18 + 2), 0);
            mem.setU8((X60Qdesugar_18 + 3), 0);
            mem.setU8((X60Qdesugar_18 + 4), 0);
            mem.setU8((X60Qdesugar_18 + 5), 0);
            mem.setU8((X60Qdesugar_18 + 6), 255);
            mem.setU8((X60Qdesugar_18 + 7), 3);
            mem.setU8((X60Qdesugar_18 + 8), 0);
            mem.setU8((X60Qdesugar_18 + 9), 0);
            mem.setU8((X60Qdesugar_18 + 10), 0);
            mem.setU8((X60Qdesugar_18 + 11), 0);
            mem.setU8((X60Qdesugar_18 + 12), 0);
            mem.setU8((X60Qdesugar_18 + 13), 0);
            mem.setU8((X60Qdesugar_18 + 14), 0);
            mem.setU8((X60Qdesugar_18 + 15), 0);
            mem.setU8((X60Qdesugar_18 + 16), 0);
            mem.setU8((X60Qdesugar_18 + 17), 0);
            mem.setU8((X60Qdesugar_18 + 18), 0);
            mem.setU8((X60Qdesugar_18 + 19), 0);
            mem.setU8((X60Qdesugar_18 + 20), 0);
            mem.setU8((X60Qdesugar_18 + 21), 0);
            mem.setU8((X60Qdesugar_18 + 22), 0);
            mem.setU8((X60Qdesugar_18 + 23), 0);
            mem.setU8((X60Qdesugar_18 + 24), 0);
            mem.setU8((X60Qdesugar_18 + 25), 0);
            mem.setU8((X60Qdesugar_18 + 26), 0);
            mem.setU8((X60Qdesugar_18 + 27), 0);
            mem.setU8((X60Qdesugar_18 + 28), 0);
            mem.setU8((X60Qdesugar_18 + 29), 0);
            mem.setU8((X60Qdesugar_18 + 30), 0);
            mem.setU8((X60Qdesugar_18 + 31), 0);
            var X60Qx_85 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
            var X60Qdesugar_19 = mem.u8At(X60Qx_85);
            X60Qx_9 = (((mem.u8At((X60Qdesugar_18 + (X60Qdesugar_19 >>> 3))) & ((1 << ((X60Qdesugar_19 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
          } else {
            X60Qx_9 = false;
          }
          if (X60Qx_9) {
            whileStmtLabel_1: {
              inc_1_I6wjjge_cmdqs323n1(kdigits_0);
              var X60Qx_86 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
              integer_0 = BigInt.asUintN(64, (BigInt.asUintN(64, (integer_0 * 10n)) + BigInt(((mem.u8At(X60Qx_86) - 48) | 0))));
              inc_1_I6wjjge_cmdqs323n1(i_2);
              {
                while (true) {
                  var X60Qx_87;
                  var X60Qx_88 = len_6_Iroq7kd1_has9tn57v(s_6);
                  if ((mem.i32(i_2) < X60Qx_88)) {
                    var X60Qx_89 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                    X60Qx_87 = (mem.u8At(X60Qx_89) === 95);
                  } else {
                    X60Qx_87 = false;
                  }
                  if (X60Qx_87) {
                    inc_1_I6wjjge_cmdqs323n1(i_2);
                  } else {
                    break;
                  }
                }
              }
            }
          } else {
            break;
          }
        }
      }
    }
    var X60Qx_90;
    var X60Qx_91 = len_6_Iroq7kd1_has9tn57v(s_6);
    if ((mem.i32(i_2) < X60Qx_91)) {
      var X60Qx_92 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
      X60Qx_90 = (mem.u8At(X60Qx_92) === 46);
    } else {
      X60Qx_90 = false;
    }
    if (X60Qx_90) {
      whileStmtLabel_4: {
        inc_1_I6wjjge_cmdqs323n1(i_2);
        if ((mem.i32(kdigits_0) <= 0)) {
          whileStmtLabel_2: {
            {
              while (true) {
                var X60Qx_93;
                var X60Qx_94 = len_6_Iroq7kd1_has9tn57v(s_6);
                if ((mem.i32(i_2) < X60Qx_94)) {
                  var X60Qx_95 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                  X60Qx_93 = (mem.u8At(X60Qx_95) === 48);
                } else {
                  X60Qx_93 = false;
                }
                if (X60Qx_93) {
                  whileStmtLabel_3: {
                    inc_1_I6wjjge_cmdqs323n1(fracExponent_0);
                    inc_1_I6wjjge_cmdqs323n1(i_2);
                    {
                      while (true) {
                        var X60Qx_96;
                        var X60Qx_97 = len_6_Iroq7kd1_has9tn57v(s_6);
                        if ((mem.i32(i_2) < X60Qx_97)) {
                          var X60Qx_98 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                          X60Qx_96 = (mem.u8At(X60Qx_98) === 95);
                        } else {
                          X60Qx_96 = false;
                        }
                        if (X60Qx_96) {
                          inc_1_I6wjjge_cmdqs323n1(i_2);
                        } else {
                          break;
                        }
                      }
                    }
                  }
                } else {
                  break;
                }
              }
            }
          }
        }
        var X60Qx_10;
        var X60Qx_99;
        if ((firstDigit_0 === -1)) {
          var X60Qx_100 = len_6_Iroq7kd1_has9tn57v(s_6);
          X60Qx_99 = (mem.i32(i_2) < X60Qx_100);
        } else {
          X60Qx_99 = false;
        }
        if (X60Qx_99) {
          var X60Qdesugar_20 = allocFixed(32);
          mem.setU8(X60Qdesugar_20, 0);
          mem.setU8((X60Qdesugar_20 + 1), 0);
          mem.setU8((X60Qdesugar_20 + 2), 0);
          mem.setU8((X60Qdesugar_20 + 3), 0);
          mem.setU8((X60Qdesugar_20 + 4), 0);
          mem.setU8((X60Qdesugar_20 + 5), 0);
          mem.setU8((X60Qdesugar_20 + 6), 255);
          mem.setU8((X60Qdesugar_20 + 7), 3);
          mem.setU8((X60Qdesugar_20 + 8), 0);
          mem.setU8((X60Qdesugar_20 + 9), 0);
          mem.setU8((X60Qdesugar_20 + 10), 0);
          mem.setU8((X60Qdesugar_20 + 11), 0);
          mem.setU8((X60Qdesugar_20 + 12), 0);
          mem.setU8((X60Qdesugar_20 + 13), 0);
          mem.setU8((X60Qdesugar_20 + 14), 0);
          mem.setU8((X60Qdesugar_20 + 15), 0);
          mem.setU8((X60Qdesugar_20 + 16), 0);
          mem.setU8((X60Qdesugar_20 + 17), 0);
          mem.setU8((X60Qdesugar_20 + 18), 0);
          mem.setU8((X60Qdesugar_20 + 19), 0);
          mem.setU8((X60Qdesugar_20 + 20), 0);
          mem.setU8((X60Qdesugar_20 + 21), 0);
          mem.setU8((X60Qdesugar_20 + 22), 0);
          mem.setU8((X60Qdesugar_20 + 23), 0);
          mem.setU8((X60Qdesugar_20 + 24), 0);
          mem.setU8((X60Qdesugar_20 + 25), 0);
          mem.setU8((X60Qdesugar_20 + 26), 0);
          mem.setU8((X60Qdesugar_20 + 27), 0);
          mem.setU8((X60Qdesugar_20 + 28), 0);
          mem.setU8((X60Qdesugar_20 + 29), 0);
          mem.setU8((X60Qdesugar_20 + 30), 0);
          mem.setU8((X60Qdesugar_20 + 31), 0);
          var X60Qx_101 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          var X60Qdesugar_21 = mem.u8At(X60Qx_101);
          X60Qx_10 = (((mem.u8At((X60Qdesugar_20 + (X60Qdesugar_21 >>> 3))) & ((1 << ((X60Qdesugar_21 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
        } else {
          X60Qx_10 = false;
        }
        if (X60Qx_10) {
          var X60Qx_102 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          firstDigit_0 = ((mem.u8At(X60Qx_102) - 48) | 0);
        }
        {
          while (true) {
            var X60Qx_11;
            var X60Qx_103 = len_6_Iroq7kd1_has9tn57v(s_6);
            if ((mem.i32(i_2) < X60Qx_103)) {
              var X60Qdesugar_22 = allocFixed(32);
              mem.setU8(X60Qdesugar_22, 0);
              mem.setU8((X60Qdesugar_22 + 1), 0);
              mem.setU8((X60Qdesugar_22 + 2), 0);
              mem.setU8((X60Qdesugar_22 + 3), 0);
              mem.setU8((X60Qdesugar_22 + 4), 0);
              mem.setU8((X60Qdesugar_22 + 5), 0);
              mem.setU8((X60Qdesugar_22 + 6), 255);
              mem.setU8((X60Qdesugar_22 + 7), 3);
              mem.setU8((X60Qdesugar_22 + 8), 0);
              mem.setU8((X60Qdesugar_22 + 9), 0);
              mem.setU8((X60Qdesugar_22 + 10), 0);
              mem.setU8((X60Qdesugar_22 + 11), 0);
              mem.setU8((X60Qdesugar_22 + 12), 0);
              mem.setU8((X60Qdesugar_22 + 13), 0);
              mem.setU8((X60Qdesugar_22 + 14), 0);
              mem.setU8((X60Qdesugar_22 + 15), 0);
              mem.setU8((X60Qdesugar_22 + 16), 0);
              mem.setU8((X60Qdesugar_22 + 17), 0);
              mem.setU8((X60Qdesugar_22 + 18), 0);
              mem.setU8((X60Qdesugar_22 + 19), 0);
              mem.setU8((X60Qdesugar_22 + 20), 0);
              mem.setU8((X60Qdesugar_22 + 21), 0);
              mem.setU8((X60Qdesugar_22 + 22), 0);
              mem.setU8((X60Qdesugar_22 + 23), 0);
              mem.setU8((X60Qdesugar_22 + 24), 0);
              mem.setU8((X60Qdesugar_22 + 25), 0);
              mem.setU8((X60Qdesugar_22 + 26), 0);
              mem.setU8((X60Qdesugar_22 + 27), 0);
              mem.setU8((X60Qdesugar_22 + 28), 0);
              mem.setU8((X60Qdesugar_22 + 29), 0);
              mem.setU8((X60Qdesugar_22 + 30), 0);
              mem.setU8((X60Qdesugar_22 + 31), 0);
              var X60Qx_104 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
              var X60Qdesugar_23 = mem.u8At(X60Qx_104);
              X60Qx_11 = (((mem.u8At((X60Qdesugar_22 + (X60Qdesugar_23 >>> 3))) & ((1 << ((X60Qdesugar_23 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
            } else {
              X60Qx_11 = false;
            }
            if (X60Qx_11) {
              whileStmtLabel_5: {
                inc_1_I6wjjge_cmdqs323n1(fdigits_0);
                inc_1_I6wjjge_cmdqs323n1(fracExponent_0);
                var X60Qx_105 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                integer_0 = BigInt.asUintN(64, (BigInt.asUintN(64, (integer_0 * 10n)) + BigInt(((mem.u8At(X60Qx_105) - 48) | 0))));
                inc_1_I6wjjge_cmdqs323n1(i_2);
                {
                  while (true) {
                    var X60Qx_106;
                    var X60Qx_107 = len_6_Iroq7kd1_has9tn57v(s_6);
                    if ((mem.i32(i_2) < X60Qx_107)) {
                      var X60Qx_108 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                      X60Qx_106 = (mem.u8At(X60Qx_108) === 95);
                    } else {
                      X60Qx_106 = false;
                    }
                    if (X60Qx_106) {
                      inc_1_I6wjjge_cmdqs323n1(i_2);
                    } else {
                      break;
                    }
                  }
                }
              }
            } else {
              break;
            }
          }
        }
      }
    }
    var X60Qx_109;
    if ((((mem.i32(kdigits_0) + mem.i32(fdigits_0)) | 0) <= 0)) {
      var X60Qx_110;
      if ((mem.i32(i_2) === 0)) {
        X60Qx_110 = true;
      } else {
        var X60Qx_111;
        if ((mem.i32(i_2) === 1)) {
          X60Qx_111 = hasSign_0;
        } else {
          X60Qx_111 = false;
        }
        X60Qx_110 = X60Qx_111;
      }
      X60Qx_109 = X60Qx_110;
    } else {
      X60Qx_109 = false;
    }
    if (X60Qx_109) {
      return 0;
    }
    var X60Qx_12;
    var X60Qx_112 = len_6_Iroq7kd1_has9tn57v(s_6);
    if ((((mem.i32(i_2) + 1) | 0) < X60Qx_112)) {
      var X60Qdesugar_24 = allocFixed(32);
      mem.setU8(X60Qdesugar_24, 0);
      mem.setU8((X60Qdesugar_24 + 1), 0);
      mem.setU8((X60Qdesugar_24 + 2), 0);
      mem.setU8((X60Qdesugar_24 + 3), 0);
      mem.setU8((X60Qdesugar_24 + 4), 0);
      mem.setU8((X60Qdesugar_24 + 5), 0);
      mem.setU8((X60Qdesugar_24 + 6), 0);
      mem.setU8((X60Qdesugar_24 + 7), 0);
      mem.setU8((X60Qdesugar_24 + 8), 32);
      mem.setU8((X60Qdesugar_24 + 9), 0);
      mem.setU8((X60Qdesugar_24 + 10), 0);
      mem.setU8((X60Qdesugar_24 + 11), 0);
      mem.setU8((X60Qdesugar_24 + 12), 32);
      mem.setU8((X60Qdesugar_24 + 13), 0);
      mem.setU8((X60Qdesugar_24 + 14), 0);
      mem.setU8((X60Qdesugar_24 + 15), 0);
      mem.setU8((X60Qdesugar_24 + 16), 0);
      mem.setU8((X60Qdesugar_24 + 17), 0);
      mem.setU8((X60Qdesugar_24 + 18), 0);
      mem.setU8((X60Qdesugar_24 + 19), 0);
      mem.setU8((X60Qdesugar_24 + 20), 0);
      mem.setU8((X60Qdesugar_24 + 21), 0);
      mem.setU8((X60Qdesugar_24 + 22), 0);
      mem.setU8((X60Qdesugar_24 + 23), 0);
      mem.setU8((X60Qdesugar_24 + 24), 0);
      mem.setU8((X60Qdesugar_24 + 25), 0);
      mem.setU8((X60Qdesugar_24 + 26), 0);
      mem.setU8((X60Qdesugar_24 + 27), 0);
      mem.setU8((X60Qdesugar_24 + 28), 0);
      mem.setU8((X60Qdesugar_24 + 29), 0);
      mem.setU8((X60Qdesugar_24 + 30), 0);
      mem.setU8((X60Qdesugar_24 + 31), 0);
      var X60Qx_113 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
      var X60Qdesugar_25 = mem.u8At(X60Qx_113);
      X60Qx_12 = (((mem.u8At((X60Qdesugar_24 + (X60Qdesugar_25 >>> 3))) & ((1 << ((X60Qdesugar_25 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
    } else {
      X60Qx_12 = false;
    }
    if (X60Qx_12) {
      whileStmtLabel_6: {
        inc_1_I6wjjge_cmdqs323n1(i_2);
        var X60Qx_114;
        var X60Qx_115 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        if ((mem.u8At(X60Qx_115) === 43)) {
          X60Qx_114 = true;
        } else {
          var X60Qx_116 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          X60Qx_114 = (mem.u8At(X60Qx_116) === 45);
        }
        if (X60Qx_114) {
          var X60Qx_117 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          if ((mem.u8At(X60Qx_117) === 45)) {
            expSign_0 = -1;
          }
          inc_1_I6wjjge_cmdqs323n1(i_2);
        }
        var X60Qdesugar_26 = allocFixed(32);
        mem.setU8(X60Qdesugar_26, 0);
        mem.setU8((X60Qdesugar_26 + 1), 0);
        mem.setU8((X60Qdesugar_26 + 2), 0);
        mem.setU8((X60Qdesugar_26 + 3), 0);
        mem.setU8((X60Qdesugar_26 + 4), 0);
        mem.setU8((X60Qdesugar_26 + 5), 0);
        mem.setU8((X60Qdesugar_26 + 6), 255);
        mem.setU8((X60Qdesugar_26 + 7), 3);
        mem.setU8((X60Qdesugar_26 + 8), 0);
        mem.setU8((X60Qdesugar_26 + 9), 0);
        mem.setU8((X60Qdesugar_26 + 10), 0);
        mem.setU8((X60Qdesugar_26 + 11), 0);
        mem.setU8((X60Qdesugar_26 + 12), 0);
        mem.setU8((X60Qdesugar_26 + 13), 0);
        mem.setU8((X60Qdesugar_26 + 14), 0);
        mem.setU8((X60Qdesugar_26 + 15), 0);
        mem.setU8((X60Qdesugar_26 + 16), 0);
        mem.setU8((X60Qdesugar_26 + 17), 0);
        mem.setU8((X60Qdesugar_26 + 18), 0);
        mem.setU8((X60Qdesugar_26 + 19), 0);
        mem.setU8((X60Qdesugar_26 + 20), 0);
        mem.setU8((X60Qdesugar_26 + 21), 0);
        mem.setU8((X60Qdesugar_26 + 22), 0);
        mem.setU8((X60Qdesugar_26 + 23), 0);
        mem.setU8((X60Qdesugar_26 + 24), 0);
        mem.setU8((X60Qdesugar_26 + 25), 0);
        mem.setU8((X60Qdesugar_26 + 26), 0);
        mem.setU8((X60Qdesugar_26 + 27), 0);
        mem.setU8((X60Qdesugar_26 + 28), 0);
        mem.setU8((X60Qdesugar_26 + 29), 0);
        mem.setU8((X60Qdesugar_26 + 30), 0);
        mem.setU8((X60Qdesugar_26 + 31), 0);
        var X60Qx_118 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
        var X60Qdesugar_27 = mem.u8At(X60Qx_118);
        if ((!(((mem.u8At((X60Qdesugar_26 + (X60Qdesugar_27 >>> 3))) & ((1 << ((X60Qdesugar_27 & 7) >>> 0)) >>> 0)) >>> 0) !== 0))) {
          return 0;
        }
        {
          while (true) {
            var X60Qx_13;
            var X60Qx_119 = len_6_Iroq7kd1_has9tn57v(s_6);
            if ((mem.i32(i_2) < X60Qx_119)) {
              var X60Qdesugar_28 = allocFixed(32);
              mem.setU8(X60Qdesugar_28, 0);
              mem.setU8((X60Qdesugar_28 + 1), 0);
              mem.setU8((X60Qdesugar_28 + 2), 0);
              mem.setU8((X60Qdesugar_28 + 3), 0);
              mem.setU8((X60Qdesugar_28 + 4), 0);
              mem.setU8((X60Qdesugar_28 + 5), 0);
              mem.setU8((X60Qdesugar_28 + 6), 255);
              mem.setU8((X60Qdesugar_28 + 7), 3);
              mem.setU8((X60Qdesugar_28 + 8), 0);
              mem.setU8((X60Qdesugar_28 + 9), 0);
              mem.setU8((X60Qdesugar_28 + 10), 0);
              mem.setU8((X60Qdesugar_28 + 11), 0);
              mem.setU8((X60Qdesugar_28 + 12), 0);
              mem.setU8((X60Qdesugar_28 + 13), 0);
              mem.setU8((X60Qdesugar_28 + 14), 0);
              mem.setU8((X60Qdesugar_28 + 15), 0);
              mem.setU8((X60Qdesugar_28 + 16), 0);
              mem.setU8((X60Qdesugar_28 + 17), 0);
              mem.setU8((X60Qdesugar_28 + 18), 0);
              mem.setU8((X60Qdesugar_28 + 19), 0);
              mem.setU8((X60Qdesugar_28 + 20), 0);
              mem.setU8((X60Qdesugar_28 + 21), 0);
              mem.setU8((X60Qdesugar_28 + 22), 0);
              mem.setU8((X60Qdesugar_28 + 23), 0);
              mem.setU8((X60Qdesugar_28 + 24), 0);
              mem.setU8((X60Qdesugar_28 + 25), 0);
              mem.setU8((X60Qdesugar_28 + 26), 0);
              mem.setU8((X60Qdesugar_28 + 27), 0);
              mem.setU8((X60Qdesugar_28 + 28), 0);
              mem.setU8((X60Qdesugar_28 + 29), 0);
              mem.setU8((X60Qdesugar_28 + 30), 0);
              mem.setU8((X60Qdesugar_28 + 31), 0);
              var X60Qx_120 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
              var X60Qdesugar_29 = mem.u8At(X60Qx_120);
              X60Qx_13 = (((mem.u8At((X60Qdesugar_28 + (X60Qdesugar_29 >>> 3))) & ((1 << ((X60Qdesugar_29 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
            } else {
              X60Qx_13 = false;
            }
            if (X60Qx_13) {
              whileStmtLabel_7: {
                var X60Qx_121 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                exponent_0 = ((Math.imul(exponent_0, 10) + ((mem.u8At(X60Qx_121) - 48) | 0)) | 0);
                inc_1_I6wjjge_cmdqs323n1(i_2);
                {
                  while (true) {
                    var X60Qx_122;
                    var X60Qx_123 = len_6_Iroq7kd1_has9tn57v(s_6);
                    if ((mem.i32(i_2) < X60Qx_123)) {
                      var X60Qx_124 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                      X60Qx_122 = (mem.u8At(X60Qx_124) === 95);
                    } else {
                      X60Qx_122 = false;
                    }
                    if (X60Qx_122) {
                      inc_1_I6wjjge_cmdqs323n1(i_2);
                    } else {
                      break;
                    }
                  }
                }
              }
            } else {
              break;
            }
          }
        }
      }
    }
    var realExponent_0 = ((Math.imul(expSign_0, exponent_0) - mem.i32(fracExponent_0)) | 0);
    var expNegative_0 = (realExponent_0 < 0);
    var absExponent_0 = abs_0_Iycnqz_party5a2l1(realExponent_0);
    if ((999 < absExponent_0)) {
      if ((integer_0 === 0n)) {
        mem.setF64(number_4, 0.0);
      } else {
        if (expNegative_0) {
          mem.setF64(number_4, (0.0 * sign_1));
        } else {
          mem.setF64(number_4, (Infinity * sign_1));
        }
      }
      return mem.i32(i_2);
    }
    var digits_0 = ((mem.i32(kdigits_0) + mem.i32(fdigits_0)) | 0);
    var X60Qx_125;
    if ((digits_0 <= 15)) {
      X60Qx_125 = true;
    } else {
      var X60Qx_126;
      if ((digits_0 <= 16)) {
        X60Qx_126 = (firstDigit_0 <= 8);
      } else {
        X60Qx_126 = false;
      }
      X60Qx_125 = X60Qx_126;
    }
    if (X60Qx_125) {
      if ((absExponent_0 <= 22)) {
        if (expNegative_0) {
          var X60Qx_127 = nimIcheckB(absExponent_0, 22);
          mem.setF64(number_4, ((sign_1 * Number(integer_0)) / mem.f64((powtens_0 + (X60Qx_127 * 8)))));
        } else {
          var X60Qx_128 = nimIcheckB(absExponent_0, 22);
          mem.setF64(number_4, ((sign_1 * Number(integer_0)) * mem.f64((powtens_0 + (X60Qx_128 * 8)))));
        }
        return mem.i32(i_2);
      }
      var slop_0 = ((((15 - mem.i32(kdigits_0)) | 0) - mem.i32(fdigits_0)) | 0);
      var X60Qx_129;
      if ((absExponent_0 <= ((22 + slop_0) | 0))) {
        X60Qx_129 = (!expNegative_0);
      } else {
        X60Qx_129 = false;
      }
      if (X60Qx_129) {
        var X60Qx_130 = nimIcheckB(slop_0, 22);
        var X60Qx_131 = nimIcheckB(((absExponent_0 - slop_0) | 0), 22);
        mem.setF64(number_4, (((sign_1 * Number(integer_0)) * mem.f64((powtens_0 + (X60Qx_130 * 8)))) * mem.f64((powtens_0 + (X60Qx_131 * 8)))));
        return mem.i32(i_2);
      }
    }
    var t_0 = allocFixed(500);
    var ti_0 = allocFixed(4);
    mem.setI32(ti_0, 0);
    var X60Qx_132 = len_4_sysvq0asl((() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 808150526);
      mem.setU32((_o + 4), strlit_0_I16254714811886502893_party5a2l1);
      return _o;
    })());
    var maxlen_0 = (((((((499 | 0) + 1) | 0) - 1) | 0) - X60Qx_132) | 0);
    var endPos_0 = mem.i32(i_2);
    result_6 = endPos_0;
    mem.setI32(i_2, 0);
    var X60Qx_133;
    if ((mem.i32(i_2) < endPos_0)) {
      var X60Qx_134 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
      X60Qx_133 = (mem.u8At(X60Qx_134) === 46);
    } else {
      X60Qx_133 = false;
    }
    if (X60Qx_133) {
      inc_1_I6wjjge_cmdqs323n1(i_2);
    }
    {
      while (true) {
        var X60Qx_14;
        if ((mem.i32(i_2) < endPos_0)) {
          var X60Qdesugar_30 = allocFixed(32);
          mem.setU8(X60Qdesugar_30, 0);
          mem.setU8((X60Qdesugar_30 + 1), 0);
          mem.setU8((X60Qdesugar_30 + 2), 0);
          mem.setU8((X60Qdesugar_30 + 3), 0);
          mem.setU8((X60Qdesugar_30 + 4), 0);
          mem.setU8((X60Qdesugar_30 + 5), 40);
          mem.setU8((X60Qdesugar_30 + 6), 255);
          mem.setU8((X60Qdesugar_30 + 7), 3);
          mem.setU8((X60Qdesugar_30 + 8), 0);
          mem.setU8((X60Qdesugar_30 + 9), 0);
          mem.setU8((X60Qdesugar_30 + 10), 0);
          mem.setU8((X60Qdesugar_30 + 11), 0);
          mem.setU8((X60Qdesugar_30 + 12), 0);
          mem.setU8((X60Qdesugar_30 + 13), 0);
          mem.setU8((X60Qdesugar_30 + 14), 0);
          mem.setU8((X60Qdesugar_30 + 15), 0);
          mem.setU8((X60Qdesugar_30 + 16), 0);
          mem.setU8((X60Qdesugar_30 + 17), 0);
          mem.setU8((X60Qdesugar_30 + 18), 0);
          mem.setU8((X60Qdesugar_30 + 19), 0);
          mem.setU8((X60Qdesugar_30 + 20), 0);
          mem.setU8((X60Qdesugar_30 + 21), 0);
          mem.setU8((X60Qdesugar_30 + 22), 0);
          mem.setU8((X60Qdesugar_30 + 23), 0);
          mem.setU8((X60Qdesugar_30 + 24), 0);
          mem.setU8((X60Qdesugar_30 + 25), 0);
          mem.setU8((X60Qdesugar_30 + 26), 0);
          mem.setU8((X60Qdesugar_30 + 27), 0);
          mem.setU8((X60Qdesugar_30 + 28), 0);
          mem.setU8((X60Qdesugar_30 + 29), 0);
          mem.setU8((X60Qdesugar_30 + 30), 0);
          mem.setU8((X60Qdesugar_30 + 31), 0);
          var X60Qx_135 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
          var X60Qdesugar_31 = mem.u8At(X60Qx_135);
          X60Qx_14 = (((mem.u8At((X60Qdesugar_30 + (X60Qdesugar_31 >>> 3))) & ((1 << ((X60Qdesugar_31 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
        } else {
          X60Qx_14 = false;
        }
        if (X60Qx_14) {
          whileStmtLabel_9: {
            if ((mem.i32(ti_0) < maxlen_0)) {
              var X60Qx_136 = nimIcheckB(mem.i32(ti_0), 499);
              var X60Qx_137 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
              mem.setU8((t_0 + X60Qx_136), mem.u8At(X60Qx_137));
              inc_1_I6wjjge_cmdqs323n1(ti_0);
            }
            inc_1_I6wjjge_cmdqs323n1(i_2);
            {
              while (true) {
                var X60Qx_15;
                if ((mem.i32(i_2) < endPos_0)) {
                  var X60Qdesugar_32 = allocFixed(32);
                  mem.setU8(X60Qdesugar_32, 0);
                  mem.setU8((X60Qdesugar_32 + 1), 0);
                  mem.setU8((X60Qdesugar_32 + 2), 0);
                  mem.setU8((X60Qdesugar_32 + 3), 0);
                  mem.setU8((X60Qdesugar_32 + 4), 0);
                  mem.setU8((X60Qdesugar_32 + 5), 64);
                  mem.setU8((X60Qdesugar_32 + 6), 0);
                  mem.setU8((X60Qdesugar_32 + 7), 0);
                  mem.setU8((X60Qdesugar_32 + 8), 0);
                  mem.setU8((X60Qdesugar_32 + 9), 0);
                  mem.setU8((X60Qdesugar_32 + 10), 0);
                  mem.setU8((X60Qdesugar_32 + 11), 128);
                  mem.setU8((X60Qdesugar_32 + 12), 0);
                  mem.setU8((X60Qdesugar_32 + 13), 0);
                  mem.setU8((X60Qdesugar_32 + 14), 0);
                  mem.setU8((X60Qdesugar_32 + 15), 0);
                  mem.setU8((X60Qdesugar_32 + 16), 0);
                  mem.setU8((X60Qdesugar_32 + 17), 0);
                  mem.setU8((X60Qdesugar_32 + 18), 0);
                  mem.setU8((X60Qdesugar_32 + 19), 0);
                  mem.setU8((X60Qdesugar_32 + 20), 0);
                  mem.setU8((X60Qdesugar_32 + 21), 0);
                  mem.setU8((X60Qdesugar_32 + 22), 0);
                  mem.setU8((X60Qdesugar_32 + 23), 0);
                  mem.setU8((X60Qdesugar_32 + 24), 0);
                  mem.setU8((X60Qdesugar_32 + 25), 0);
                  mem.setU8((X60Qdesugar_32 + 26), 0);
                  mem.setU8((X60Qdesugar_32 + 27), 0);
                  mem.setU8((X60Qdesugar_32 + 28), 0);
                  mem.setU8((X60Qdesugar_32 + 29), 0);
                  mem.setU8((X60Qdesugar_32 + 30), 0);
                  mem.setU8((X60Qdesugar_32 + 31), 0);
                  var X60Qx_138 = getQ_10_I5nt6we_has9tn57v(s_6, mem.i32(i_2));
                  var X60Qdesugar_33 = mem.u8At(X60Qx_138);
                  X60Qx_15 = (((mem.u8At((X60Qdesugar_32 + (X60Qdesugar_33 >>> 3))) & ((1 << ((X60Qdesugar_33 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
                } else {
                  X60Qx_15 = false;
                }
                if (X60Qx_15) {
                  inc_1_I6wjjge_cmdqs323n1(i_2);
                } else {
                  break;
                }
              }
            }
          }
        } else {
          break;
        }
      }
    }
  }
  var X60Qx_139 = nimIcheckB(mem.i32(ti_0), 499);
  mem.setU8((t_0 + X60Qx_139), 69);
  inc_1_I6wjjge_cmdqs323n1(ti_0);
  var X60Qx_16;
  if (expNegative_0) {
    X60Qx_16 = 45;
  } else {
    X60Qx_16 = 43;
  }
  var X60Qx_140 = nimIcheckB(mem.i32(ti_0), 499);
  mem.setU8((t_0 + X60Qx_140), X60Qx_16);
  inc_0_Iloplki_party5a2l1(ti_0, 4);
  var X60Qx_141 = nimIcheckB(((mem.i32(ti_0) - 1) | 0), 499);
  mem.setU8((t_0 + X60Qx_141), (((48 + (absExponent_0 % 10)) | 0) & 255));
  absExponent_0 = Math.trunc((absExponent_0 / 10));
  var X60Qx_142 = nimIcheckB(((mem.i32(ti_0) - 2) | 0), 499);
  mem.setU8((t_0 + X60Qx_142), (((48 + (absExponent_0 % 10)) | 0) & 255));
  absExponent_0 = Math.trunc((absExponent_0 / 10));
  var X60Qx_143 = nimIcheckB(((mem.i32(ti_0) - 3) | 0), 499);
  mem.setU8((t_0 + X60Qx_143), (((48 + (absExponent_0 % 10)) | 0) & 255));
  var X60Qx_144 = nimIcheckB(mem.i32(ti_0), 499);
  mem.setU8((t_0 + X60Qx_144), 0);
  var X60Qx_145 = strtod(t_0, 0);
  mem.setF64(number_4, X60Qx_145);
  return result_6;
}

function inc_0_Ineawm41_party5a2l1(x_8, y_2) {
  mem.setU64(x_8, BigInt.asUintN(64, (mem.u64b(x_8) + y_2)));
}

function abs_0_Iycnqz_party5a2l1(x_9) {
  let result_14;
  let X60Qx_18;
  if ((x_9 < 0)) {
    X60Qx_18 = (-x_9);
  } else {
    X60Qx_18 = x_9;
  }
  result_14 = X60Qx_18;
  return result_14;
}

function inc_0_Iloplki_party5a2l1(x_10, y_3) {
  mem.setI32(x_10, ((mem.i32(x_10) + y_3) | 0));
}

let X60QiniGuard_0_party5a2l1 = allocFixed(1);

function X60Qini_0_party5a2l1() {
  if (mem.u8At(X60QiniGuard_0_party5a2l1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_party5a2l1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_assy765wm();
}
// generated by lengc (js backend) from pat4k2dls.c.nif

let X60QiniGuard_0_pat4k2dls = allocFixed(1);

function X60Qini_0_pat4k2dls() {
  if (mem.u8At(X60QiniGuard_0_pat4k2dls)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_pat4k2dls, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_ossk30t39();
  X60Qini_0_osalirkw71();
  X60Qini_0_patta6rli();
  X60Qini_0_has9tn57v();
  X60Qini_0_str7j0ifg();
  X60Qini_0_ospaexnw61();
}
// generated by lengc (js backend) from nifjp9lau1.c.nif

function open_1_nifjp9lau1(sizeHint_0, compact_1) {
  let result_2 = allocFixed(28);
  eQwasmovedQ_SX42uilder0nifjp9lau1_0_nifjp9lau1(result_2);
  eQdestroyQ_SX42uilder0nifjp9lau1_0_nifjp9lau1(result_2);
  let X60Qx_18 = allocFixed(8);
  mem.copy(X60Qx_18, newStringOfCap_0_sysvq0asl(sizeHint_0), 8);
  mem.copy(result_2, (() => {
    let _o = allocFixed(28);
    mem.copy(_o, X60Qx_18, 8);
    mem.setU8((_o + 8), 0);
    mem.setU8((_o + 9), 0);
    mem.setU8((_o + 10), compact_1);
    mem.copy((_o + 12), (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    mem.setI32((_o + 20), 0);
    mem.setI32((_o + 24), 0);
    return _o;
  })(), 28);
  return result_2;
}

function extract_0_nifjp9lau1(b_1) {
  let result_4 = allocFixed(8);
  nimStrWasMoved(result_4);
  if ((!(mem.i32((b_1 + 20)) === 0))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    let X60Qtmp_1 = allocFixed(8);
    mem.copy(X60Qtmp_1, dollarQ_2_sysvq0asl(mem.i32((b_1 + 20))), 8);
    let X60Qtmp_0 = allocFixed(8);
    mem.copy(X60Qtmp_0, ampQ_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1886287358);
      mem.setU32((_o + 4), strlit_0_I10206930254104378444_nifjp9lau1);
      return _o;
    })(), X60Qtmp_1), 8);
    write_0_syn1lfpjv(stdout, X60Qtmp_0);
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
    nimStrDestroy(X60Qtmp_0);
    nimStrDestroy(X60Qtmp_1);
  }
  if ((!(mem.u8At((b_1 + 8)) === 0))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1851876350);
      mem.setU32((_o + 4), strlit_0_I738618324702527352_nifjp9lau1);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  nimStrDestroy(result_4);
  let X60Qx_19 = allocFixed(8);
  mem.copy(X60Qx_19, move_0_Isxfjyr_cmdqs323n1(b_1), 8);
  mem.copy(result_4, X60Qx_19, 8);
  eQdestroyQ_SX42uilder0nifjp9lau1_0_nifjp9lau1(b_1);
  return result_4;
  eQdestroyQ_SX42uilder0nifjp9lau1_0_nifjp9lau1(b_1);
  return result_4;
}

function putPending_0_nifjp9lau1(b_3, s_0) {
  add_2_sysvq0asl(b_3, s_0);
  let X60Qx_23 = len_4_sysvq0asl(s_0);
  plusQeQ_0_Iz7fdp7_mat7cnfv21((b_3 + 24), X60Qx_23);
}

function drainPending_0_nifjp9lau1(b_4) {
}

function put_0_nifjp9lau1(b_5, s_1) {
  add_2_sysvq0asl(b_5, s_1);
  let X60Qx_24 = len_4_sysvq0asl(s_1);
  plusQeQ_0_Iz7fdp7_mat7cnfv21((b_5 + 24), X60Qx_24);
}

function put_1_nifjp9lau1(b_6, s_2) {
  add_1_sysvq0asl(b_6, s_2);
  plusQeQ_0_Iz7fdp7_mat7cnfv21((b_6 + 24), 1);
}

function undoWhitespace_0_nifjp9lau1(b_7) {
  whileStmtLabel_0: {
    var X60Qx_25 = len_4_sysvq0asl(b_7);
    var i_1 = allocFixed(4);
    mem.setI32(i_1, ((X60Qx_25 - 1) | 0));
    {
      while (true) {
        var X60Qx_0;
        if ((0 <= mem.i32(i_1))) {
          var X60Qdesugar_0 = allocFixed(32);
          mem.setU8(X60Qdesugar_0, 0);
          mem.setU8((X60Qdesugar_0 + 1), 4);
          mem.setU8((X60Qdesugar_0 + 2), 0);
          mem.setU8((X60Qdesugar_0 + 3), 0);
          mem.setU8((X60Qdesugar_0 + 4), 1);
          mem.setU8((X60Qdesugar_0 + 5), 0);
          mem.setU8((X60Qdesugar_0 + 6), 0);
          mem.setU8((X60Qdesugar_0 + 7), 0);
          mem.setU8((X60Qdesugar_0 + 8), 0);
          mem.setU8((X60Qdesugar_0 + 9), 0);
          mem.setU8((X60Qdesugar_0 + 10), 0);
          mem.setU8((X60Qdesugar_0 + 11), 0);
          mem.setU8((X60Qdesugar_0 + 12), 0);
          mem.setU8((X60Qdesugar_0 + 13), 0);
          mem.setU8((X60Qdesugar_0 + 14), 0);
          mem.setU8((X60Qdesugar_0 + 15), 0);
          mem.setU8((X60Qdesugar_0 + 16), 0);
          mem.setU8((X60Qdesugar_0 + 17), 0);
          mem.setU8((X60Qdesugar_0 + 18), 0);
          mem.setU8((X60Qdesugar_0 + 19), 0);
          mem.setU8((X60Qdesugar_0 + 20), 0);
          mem.setU8((X60Qdesugar_0 + 21), 0);
          mem.setU8((X60Qdesugar_0 + 22), 0);
          mem.setU8((X60Qdesugar_0 + 23), 0);
          mem.setU8((X60Qdesugar_0 + 24), 0);
          mem.setU8((X60Qdesugar_0 + 25), 0);
          mem.setU8((X60Qdesugar_0 + 26), 0);
          mem.setU8((X60Qdesugar_0 + 27), 0);
          mem.setU8((X60Qdesugar_0 + 28), 0);
          mem.setU8((X60Qdesugar_0 + 29), 0);
          mem.setU8((X60Qdesugar_0 + 30), 0);
          mem.setU8((X60Qdesugar_0 + 31), 0);
          var X60Qx_26 = getQ_9_sysvq0asl(b_7, mem.i32(i_1));
          var X60Qdesugar_1 = X60Qx_26;
          X60Qx_0 = (((mem.u8At((X60Qdesugar_0 + (X60Qdesugar_1 >>> 3))) & ((1 << ((X60Qdesugar_1 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
        } else {
          X60Qx_0 = false;
        }
        if (X60Qx_0) {
          dec_1_I0nzoz91_envto7w6l1(i_1);
          minusQeQ_0_Ipe1u69_nifjp9lau1((b_7 + 24), 1);
        } else {
          break;
        }
      }
    }
  }
  setLen_1_sysvq0asl(b_7, ((mem.i32(i_1) + 1) | 0));
}

function escape_0_nifjp9lau1(b_8, c_0) {
  let HexChars_0 = allocFixed(8);
  mem.setU32(HexChars_0, 842084606);
  mem.setU32((HexChars_0 + 4), strlit_0_I7901555537561129428_nifjp9lau1);
  let n_0 = c_0;
  put_1_nifjp9lau1(b_8, 92);
  let X60Qx_27 = getQ_9_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 842084606);
    mem.setU32((_o + 4), strlit_0_I7901555537561129428_nifjp9lau1);
    return _o;
  })(), ((n_0 >> 4) & 15));
  put_1_nifjp9lau1(b_8, X60Qx_27);
  let X60Qx_28 = getQ_9_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 842084606);
    mem.setU32((_o + 4), strlit_0_I7901555537561129428_nifjp9lau1);
    return _o;
  })(), (n_0 & 15));
  put_1_nifjp9lau1(b_8, X60Qx_28);
}

function addRaw_0_nifjp9lau1(b_9, s_3) {
  put_0_nifjp9lau1(b_9, s_3);
}

function addSep_0_nifjp9lau1(b_10) {
  let X60Qx_29 = len_4_sysvq0asl(b_10);
  if ((X60Qx_29 === 0)) {
  } else {
    let X60Qdesugar_2 = allocFixed(32);
    mem.setU8(X60Qdesugar_2, 0);
    mem.setU8((X60Qdesugar_2 + 1), 4);
    mem.setU8((X60Qdesugar_2 + 2), 0);
    mem.setU8((X60Qdesugar_2 + 3), 0);
    mem.setU8((X60Qdesugar_2 + 4), 1);
    mem.setU8((X60Qdesugar_2 + 5), 3);
    mem.setU8((X60Qdesugar_2 + 6), 0);
    mem.setU8((X60Qdesugar_2 + 7), 0);
    mem.setU8((X60Qdesugar_2 + 8), 0);
    mem.setU8((X60Qdesugar_2 + 9), 0);
    mem.setU8((X60Qdesugar_2 + 10), 0);
    mem.setU8((X60Qdesugar_2 + 11), 0);
    mem.setU8((X60Qdesugar_2 + 12), 0);
    mem.setU8((X60Qdesugar_2 + 13), 0);
    mem.setU8((X60Qdesugar_2 + 14), 0);
    mem.setU8((X60Qdesugar_2 + 15), 0);
    mem.setU8((X60Qdesugar_2 + 16), 0);
    mem.setU8((X60Qdesugar_2 + 17), 0);
    mem.setU8((X60Qdesugar_2 + 18), 0);
    mem.setU8((X60Qdesugar_2 + 19), 0);
    mem.setU8((X60Qdesugar_2 + 20), 0);
    mem.setU8((X60Qdesugar_2 + 21), 0);
    mem.setU8((X60Qdesugar_2 + 22), 0);
    mem.setU8((X60Qdesugar_2 + 23), 0);
    mem.setU8((X60Qdesugar_2 + 24), 0);
    mem.setU8((X60Qdesugar_2 + 25), 0);
    mem.setU8((X60Qdesugar_2 + 26), 0);
    mem.setU8((X60Qdesugar_2 + 27), 0);
    mem.setU8((X60Qdesugar_2 + 28), 0);
    mem.setU8((X60Qdesugar_2 + 29), 0);
    mem.setU8((X60Qdesugar_2 + 30), 0);
    mem.setU8((X60Qdesugar_2 + 31), 0);
    let X60Qx_30 = len_4_sysvq0asl(b_10);
    let X60Qx_31 = getQ_9_sysvq0asl(b_10, ((X60Qx_30 - 1) | 0));
    let X60Qdesugar_3 = X60Qx_31;
    if ((((mem.u8At((X60Qdesugar_2 + (X60Qdesugar_3 >>> 3))) & ((1 << ((X60Qdesugar_3 & 7) >>> 0)) >>> 0)) >>> 0) !== 0)) {
      let X60Qx_32 = allocFixed(8);
      mem.setU32(X60Qx_32, 544173822);
      mem.setU32((X60Qx_32 + 4), strlit_0_I2641880525336905210_nifjp9lau1);
    } else {
      putPending_0_nifjp9lau1(b_10, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 8193);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
    }
  }
}

function addIdent_0_nifjp9lau1(b_12, s_5) {
  addSep_0_nifjp9lau1(b_12);
  var X60Qx_33 = len_4_sysvq0asl(s_5);
  if ((0 < X60Qx_33)) {
    forStmtLabel_0: {
      var c_3 = getQ_9_sysvq0asl(s_5, 0);
      var X60Qx_1;
      var X60Qx_2;
      if ((c_3 < 32)) {
        X60Qx_2 = true;
      } else {
        var X60Qdesugar_4 = allocFixed(32);
        mem.setU8(X60Qdesugar_4, 0);
        mem.setU8((X60Qdesugar_4 + 1), 0);
        mem.setU8((X60Qdesugar_4 + 2), 0);
        mem.setU8((X60Qdesugar_4 + 3), 0);
        mem.setU8((X60Qdesugar_4 + 4), 0);
        mem.setU8((X60Qdesugar_4 + 5), 104);
        mem.setU8((X60Qdesugar_4 + 6), 255);
        mem.setU8((X60Qdesugar_4 + 7), 3);
        mem.setU8((X60Qdesugar_4 + 8), 0);
        mem.setU8((X60Qdesugar_4 + 9), 0);
        mem.setU8((X60Qdesugar_4 + 10), 0);
        mem.setU8((X60Qdesugar_4 + 11), 0);
        mem.setU8((X60Qdesugar_4 + 12), 0);
        mem.setU8((X60Qdesugar_4 + 13), 0);
        mem.setU8((X60Qdesugar_4 + 14), 0);
        mem.setU8((X60Qdesugar_4 + 15), 64);
        mem.setU8((X60Qdesugar_4 + 16), 0);
        mem.setU8((X60Qdesugar_4 + 17), 0);
        mem.setU8((X60Qdesugar_4 + 18), 0);
        mem.setU8((X60Qdesugar_4 + 19), 0);
        mem.setU8((X60Qdesugar_4 + 20), 0);
        mem.setU8((X60Qdesugar_4 + 21), 0);
        mem.setU8((X60Qdesugar_4 + 22), 0);
        mem.setU8((X60Qdesugar_4 + 23), 0);
        mem.setU8((X60Qdesugar_4 + 24), 0);
        mem.setU8((X60Qdesugar_4 + 25), 0);
        mem.setU8((X60Qdesugar_4 + 26), 0);
        mem.setU8((X60Qdesugar_4 + 27), 0);
        mem.setU8((X60Qdesugar_4 + 28), 0);
        mem.setU8((X60Qdesugar_4 + 29), 0);
        mem.setU8((X60Qdesugar_4 + 30), 0);
        mem.setU8((X60Qdesugar_4 + 31), 0);
        var X60Qdesugar_5 = c_3;
        X60Qx_2 = (((mem.u8At((X60Qdesugar_4 + (X60Qdesugar_5 >>> 3))) & ((1 << ((X60Qdesugar_5 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
      }
      if (X60Qx_2) {
        X60Qx_1 = true;
      } else {
        var X60Qx_3;
        if ((c_3 < 32)) {
          X60Qx_3 = true;
        } else {
          var X60Qdesugar_6 = allocFixed(32);
          mem.copy(X60Qdesugar_6, ControlChars_0_nifjp9lau1, 32);
          var X60Qdesugar_7 = c_3;
          X60Qx_3 = (((mem.u8At((X60Qdesugar_6 + (X60Qdesugar_7 >>> 3))) & ((1 << ((X60Qdesugar_7 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
        }
        X60Qx_1 = X60Qx_3;
      }
      if (X60Qx_1) {
        escape_0_nifjp9lau1(b_12, c_3);
      } else {
        put_1_nifjp9lau1(b_12, c_3);
      }
      {
        whileStmtLabel_1: {
          var X60Qlf_0 = 1;
          var X60Qlf_1 = len_4_sysvq0asl(s_5);
          var X60Qlf_2 = allocFixed(4);
          mem.setI32(X60Qlf_2, X60Qlf_0);
          {
            while ((mem.i32(X60Qlf_2) < X60Qlf_1)) {
              {
                var X60Qii_2 = getQ_9_sysvq0asl(s_5, mem.i32(X60Qlf_2));
                var X60Qx_4;
                if ((X60Qii_2 < 32)) {
                  X60Qx_4 = true;
                } else {
                  var X60Qdesugar_8 = allocFixed(32);
                  mem.copy(X60Qdesugar_8, ControlChars_0_nifjp9lau1, 32);
                  var X60Qdesugar_9 = allocFixed(32);
                  mem.setU8(X60Qdesugar_9, 0);
                  mem.setU8((X60Qdesugar_9 + 1), 0);
                  mem.setU8((X60Qdesugar_9 + 2), 0);
                  mem.setU8((X60Qdesugar_9 + 3), 0);
                  mem.setU8((X60Qdesugar_9 + 4), 0);
                  mem.setU8((X60Qdesugar_9 + 5), 64);
                  mem.setU8((X60Qdesugar_9 + 6), 0);
                  mem.setU8((X60Qdesugar_9 + 7), 0);
                  mem.setU8((X60Qdesugar_9 + 8), 0);
                  mem.setU8((X60Qdesugar_9 + 9), 0);
                  mem.setU8((X60Qdesugar_9 + 10), 0);
                  mem.setU8((X60Qdesugar_9 + 11), 0);
                  mem.setU8((X60Qdesugar_9 + 12), 0);
                  mem.setU8((X60Qdesugar_9 + 13), 0);
                  mem.setU8((X60Qdesugar_9 + 14), 0);
                  mem.setU8((X60Qdesugar_9 + 15), 0);
                  mem.setU8((X60Qdesugar_9 + 16), 0);
                  mem.setU8((X60Qdesugar_9 + 17), 0);
                  mem.setU8((X60Qdesugar_9 + 18), 0);
                  mem.setU8((X60Qdesugar_9 + 19), 0);
                  mem.setU8((X60Qdesugar_9 + 20), 0);
                  mem.setU8((X60Qdesugar_9 + 21), 0);
                  mem.setU8((X60Qdesugar_9 + 22), 0);
                  mem.setU8((X60Qdesugar_9 + 23), 0);
                  mem.setU8((X60Qdesugar_9 + 24), 0);
                  mem.setU8((X60Qdesugar_9 + 25), 0);
                  mem.setU8((X60Qdesugar_9 + 26), 0);
                  mem.setU8((X60Qdesugar_9 + 27), 0);
                  mem.setU8((X60Qdesugar_9 + 28), 0);
                  mem.setU8((X60Qdesugar_9 + 29), 0);
                  mem.setU8((X60Qdesugar_9 + 30), 0);
                  mem.setU8((X60Qdesugar_9 + 31), 0);
                  var X60Qdesugar_10 = allocFixed(32);
                  var X60Qdesugar_11 = 0;
                  while ((X60Qdesugar_11 < 32n)) {
                    mem.setU8((X60Qdesugar_10 + X60Qdesugar_11), ((mem.u8At((X60Qdesugar_8 + X60Qdesugar_11)) | mem.u8At((X60Qdesugar_9 + X60Qdesugar_11))) >>> 0));
                    X60Qdesugar_11 = ((X60Qdesugar_11 + 1) | 0);
                  }
                  var X60Qdesugar_12 = allocFixed(32);
                  mem.copy(X60Qdesugar_12, X60Qdesugar_10, 32);
                  var X60Qdesugar_13 = X60Qii_2;
                  X60Qx_4 = (((mem.u8At((X60Qdesugar_12 + (X60Qdesugar_13 >>> 3))) & ((1 << ((X60Qdesugar_13 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
                }
                if (X60Qx_4) {
                  escape_0_nifjp9lau1(b_12, X60Qii_2);
                } else {
                  put_1_nifjp9lau1(b_12, X60Qii_2);
                }
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_2);
            }
          }
        }
      }
    }
  }
}

function addStrLit_0_nifjp9lau1(b_18, s_11) {
  forStmtLabel_0: {
    addSep_0_nifjp9lau1(b_18);
    put_1_nifjp9lau1(b_18, 34);
    {
      whileStmtLabel_1: {
        var X60Qlf_6 = allocFixed(8);
        mem.copy(X60Qlf_6, toOpenArray_2_sysvq0asl(s_11), 8);
        var X60Qlf_7 = allocFixed(4);
        mem.setI32(X60Qlf_7, 0);
        {
          while (true) {
            var X60Qx_49 = len_6_Iroq7kd1_has9tn57v(X60Qlf_6);
            if ((mem.i32(X60Qlf_7) < X60Qx_49)) {
              {
                var X60Qii_2 = getQ_10_I5nt6we_has9tn57v(X60Qlf_6, mem.i32(X60Qlf_7));
                var X60Qx_9;
                if ((mem.u8At(X60Qii_2) < 32)) {
                  X60Qx_9 = true;
                } else {
                  var X60Qdesugar_20 = allocFixed(32);
                  mem.copy(X60Qdesugar_20, ControlChars_0_nifjp9lau1, 32);
                  var X60Qdesugar_21 = mem.u8At(X60Qii_2);
                  X60Qx_9 = (((mem.u8At((X60Qdesugar_20 + (X60Qdesugar_21 >>> 3))) & ((1 << ((X60Qdesugar_21 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
                }
                if (X60Qx_9) {
                  escape_0_nifjp9lau1(b_18, mem.u8At(X60Qii_2));
                } else {
                  put_1_nifjp9lau1(b_18, mem.u8At(X60Qii_2));
                }
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_7);
            } else {
              break;
            }
          }
        }
      }
    }
  }
  put_1_nifjp9lau1(b_18, 34);
}

function addEmpty_0_nifjp9lau1(b_19, count_0) {
  forStmtLabel_0: {
    addSep_0_nifjp9lau1(b_19);
    {
      whileStmtLabel_1: {
        var X60Qlf_8 = 1;
        var X60Qlf_9 = count_0;
        var X60Qlf_10 = allocFixed(4);
        mem.setI32(X60Qlf_10, X60Qlf_8);
        {
          while ((mem.i32(X60Qlf_10) <= X60Qlf_9)) {
            {
              put_1_nifjp9lau1(b_19, 46);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_10);
          }
        }
      }
    }
  }
}

function addCharLit_0_nifjp9lau1(b_20, c_2) {
  addSep_0_nifjp9lau1(b_20);
  put_1_nifjp9lau1(b_20, 39);
  let X60Qx_10;
  if ((c_2 < 32)) {
    X60Qx_10 = true;
  } else {
    let X60Qdesugar_22 = allocFixed(32);
    mem.copy(X60Qdesugar_22, ControlChars_0_nifjp9lau1, 32);
    let X60Qdesugar_23 = c_2;
    X60Qx_10 = (((mem.u8At((X60Qdesugar_22 + (X60Qdesugar_23 >>> 3))) & ((1 << ((X60Qdesugar_23 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
  }
  if (X60Qx_10) {
    escape_0_nifjp9lau1(b_20, c_2);
  } else {
    put_1_nifjp9lau1(b_20, c_2);
  }
  put_1_nifjp9lau1(b_20, 39);
}

function addIntLit_0_nifjp9lau1(b_21, i_0) {
  addSep_0_nifjp9lau1(b_21);
  let X60Qtmp_3 = allocFixed(8);
  mem.copy(X60Qtmp_3, dollarQ_1_sysvq0asl(i_0), 8);
  put_0_nifjp9lau1(b_21, X60Qtmp_3);
  nimStrDestroy(X60Qtmp_3);
}

function addUIntLit_0_nifjp9lau1(b_22, u_0) {
  addSep_0_nifjp9lau1(b_22);
  let X60Qtmp_4 = allocFixed(8);
  mem.copy(X60Qtmp_4, dollarQ_0_sysvq0asl(u_0), 8);
  put_0_nifjp9lau1(b_22, X60Qtmp_4);
  add_1_sysvq0asl(b_22, 117);
  plusQeQ_0_Iz7fdp7_mat7cnfv21((b_22 + 24), 1);
  nimStrDestroy(X60Qtmp_4);
}

function addFloatLit_0_nifjp9lau1(b_24, f_0, col_1, line_1, file_1) {
  addSep_0_nifjp9lau1(b_24);
  var X60Qx_50;
  var X60Qx_51;
  if ((!(col_1 === 0))) {
    X60Qx_51 = true;
  } else {
    X60Qx_51 = (!(line_1 === 0));
  }
  if (X60Qx_51) {
    X60Qx_50 = true;
  } else {
    var X60Qx_52 = len_4_sysvq0asl(file_1);
    X60Qx_50 = (0 < X60Qx_52);
  }
  var hasInfo_0 = X60Qx_50;
  var X60Qx_53 = classify_0_Iva37xy1_nifjp9lau1(f_0);
  switch (X60Qx_53) {
    case 5:
      {
        put_0_nifjp9lau1(b_24, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1852385534);
          mem.setU32((_o + 4), strlit_0_I6985518380653593946_nifjp9lau1);
          return _o;
        })());
        if (hasInfo_0) {
          attachLineInfo_1_nifjp9lau1(b_24, col_1, line_1, file_1);
        }
        put_1_nifjp9lau1(b_24, 41);
      }
      break;
    case 4:
      {
        put_0_nifjp9lau1(b_24, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1634609406);
          mem.setU32((_o + 4), strlit_0_I12182831138765611011_nifjp9lau1);
          return _o;
        })());
        if (hasInfo_0) {
          attachLineInfo_1_nifjp9lau1(b_24, col_1, line_1, file_1);
        }
        put_1_nifjp9lau1(b_24, 41);
      }
      break;
    case 6:
      {
        put_0_nifjp9lau1(b_24, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1701718270);
          mem.setU32((_o + 4), strlit_0_I10166291543601148343_nifjp9lau1);
          return _o;
        })());
        if (hasInfo_0) {
          attachLineInfo_1_nifjp9lau1(b_24, col_1, line_1, file_1);
        }
        put_1_nifjp9lau1(b_24, 41);
      }
      break;
    case 3:
      {
        put_0_nifjp9lau1(b_24, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 774909438);
          mem.setU32((_o + 4), strlit_0_I17577884300256341180_nifjp9lau1);
          return _o;
        })());
        if (hasInfo_0) {
          attachLineInfo_1_nifjp9lau1(b_24, col_1, line_1, file_1);
        }
      }
      break;
    case 0:
    case 1:
    case 2:
      {
        forStmtLabel_0: {
          var myLen_0 = len_4_sysvq0asl(b_24);
          addFloat_0_sysvq0asl(b_24, f_0);
          {
            whileStmtLabel_1: {
              var X60Qlf_11 = myLen_0;
              var X60Qlf_12 = len_4_sysvq0asl(b_24);
              var X60Qlf_13 = allocFixed(4);
              mem.setI32(X60Qlf_13, X60Qlf_11);
              {
                while ((mem.i32(X60Qlf_13) < X60Qlf_12)) {
                  {
                    var X60Qx_54 = getQ_9_sysvq0asl(b_24, mem.i32(X60Qlf_13));
                    if ((X60Qx_54 === 101)) {
                      putQ_9_sysvq0asl(b_24, mem.i32(X60Qlf_13), 69);
                    }
                  }
                  inc_1_I6wjjge_cmdqs323n1(X60Qlf_13);
                }
              }
            }
          }
        }
        var X60Qx_55 = len_4_sysvq0asl(b_24);
        plusQeQ_0_Iz7fdp7_mat7cnfv21((b_24 + 24), ((X60Qx_55 - myLen_0) | 0));
        if (hasInfo_0) {
          attachLineInfo_1_nifjp9lau1(b_24, col_1, line_1, file_1);
        }
      }
      break;
  }
}

function b62Char_0_nifjp9lau1(d_0) {
  let result_7;
  let X60Qx_11;
  if ((d_0 < 10)) {
    X60Qx_11 = (((48 + d_0) | 0) & 255);
  } else {
    if ((d_0 < 36)) {
      X60Qx_11 = (((((65 + d_0) | 0) - 10) | 0) & 255);
    } else {
      X60Qx_11 = (((((97 + d_0) | 0) - 36) | 0) & 255);
    }
  }
  result_7 = X60Qx_11;
  return result_7;
}

function addB62Unsigned_0_nifjp9lau1(b_25, n0_0) {
  if ((n0_0 === 0n)) {
    put_1_nifjp9lau1(b_25, 48);
  } else {
    whileStmtLabel_1: {
      whileStmtLabel_0: {
        var buf_0 = allocFixed(12);
        var i_6 = allocFixed(4);
        mem.setI32(i_6, 0);
        var n_1 = n0_0;
        {
          while ((0n < n_1)) {
            var X60Qx_56 = nimIcheckB(mem.i32(i_6), 11);
            var X60Qx_57 = b62Char_0_nifjp9lau1(Number(BigInt.asIntN(32, (n_1 % 62n))));
            mem.setU8((buf_0 + X60Qx_56), X60Qx_57);
            n_1 = (n_1 / 62n);
            inc_1_I6wjjge_cmdqs323n1(i_6);
          }
        }
      }
      {
        while ((0 < mem.i32(i_6))) {
          dec_1_I0nzoz91_envto7w6l1(i_6);
          var X60Qx_58 = nimIcheckB(mem.i32(i_6), 11);
          put_1_nifjp9lau1(b_25, mem.u8At((buf_0 + X60Qx_58)));
        }
      }
    }
  }
}

function addLineDiff_0_nifjp9lau1(b_26, x_0, emitZero_0) {
  if ((x_0 < 0)) {
    put_1_nifjp9lau1(b_26, 126);
    addB62Unsigned_0_nifjp9lau1(b_26, BigInt.asUintN(64, BigInt.asIntN(64, (-BigInt(x_0)))));
  } else {
    if ((0 < x_0)) {
      addB62Unsigned_0_nifjp9lau1(b_26, BigInt(x_0));
    } else {
      if (emitZero_0) {
        put_1_nifjp9lau1(b_26, 48);
      }
    }
  }
}

function attachLineInfo_1_nifjp9lau1(b_27, col_2, line_2, file_2) {
  var X60Qx_59;
  var X60Qx_60;
  if ((col_2 === 0)) {
    X60Qx_60 = (line_2 === 0);
  } else {
    X60Qx_60 = false;
  }
  if (X60Qx_60) {
    var X60Qx_61 = len_4_sysvq0asl(file_2);
    X60Qx_59 = (X60Qx_61 === 0);
  } else {
    X60Qx_59 = false;
  }
  if (X60Qx_59) {
    return;
  }
  drainPending_0_nifjp9lau1(b_27);
  if ((col_2 < 0)) {
    put_1_nifjp9lau1(b_27, 126);
    addB62Unsigned_0_nifjp9lau1(b_27, BigInt.asUintN(64, BigInt.asIntN(64, (-BigInt(col_2)))));
  } else {
    put_1_nifjp9lau1(b_27, 64);
    if ((0 < col_2)) {
      addB62Unsigned_0_nifjp9lau1(b_27, BigInt(col_2));
    }
  }
  var X60Qx_62;
  if ((!(line_2 === 0))) {
    X60Qx_62 = true;
  } else {
    var X60Qx_63 = len_4_sysvq0asl(file_2);
    X60Qx_62 = (0 < X60Qx_63);
  }
  if (X60Qx_62) {
    put_1_nifjp9lau1(b_27, 44);
    addLineDiff_0_nifjp9lau1(b_27, line_2, false);
  }
  var X60Qx_64 = len_4_sysvq0asl(file_2);
  if ((0 < X60Qx_64)) {
    forStmtLabel_0: {
      put_1_nifjp9lau1(b_27, 44);
      {
        whileStmtLabel_1: {
          var X60Qlf_14 = allocFixed(8);
          mem.copy(X60Qlf_14, toOpenArray_2_sysvq0asl(file_2), 8);
          var X60Qlf_15 = allocFixed(4);
          mem.setI32(X60Qlf_15, 0);
          {
            while (true) {
              var X60Qx_65 = len_6_Iroq7kd1_has9tn57v(X60Qlf_14);
              if ((mem.i32(X60Qlf_15) < X60Qx_65)) {
                {
                  var X60Qii_2 = getQ_10_I5nt6we_has9tn57v(X60Qlf_14, mem.i32(X60Qlf_15));
                  var X60Qx_12;
                  if ((mem.u8At(X60Qii_2) < 32)) {
                    X60Qx_12 = true;
                  } else {
                    var X60Qdesugar_24 = allocFixed(32);
                    mem.copy(X60Qdesugar_24, ControlChars_0_nifjp9lau1, 32);
                    var X60Qdesugar_25 = mem.u8At(X60Qii_2);
                    X60Qx_12 = (((mem.u8At((X60Qdesugar_24 + (X60Qdesugar_25 >>> 3))) & ((1 << ((X60Qdesugar_25 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
                  }
                  if (X60Qx_12) {
                    escape_0_nifjp9lau1(b_27, mem.u8At(X60Qii_2));
                  } else {
                    put_1_nifjp9lau1(b_27, mem.u8At(X60Qii_2));
                  }
                }
                inc_1_I6wjjge_cmdqs323n1(X60Qlf_15);
              } else {
                break;
              }
            }
          }
        }
      }
    }
  }
}

function addTree_0_nifjp9lau1(b_31, kind_0) {
  drainPending_0_nifjp9lau1(b_31);
  if ((!mem.u8At((b_31 + 10)))) {
    if ((0 < mem.i32((b_31 + 20)))) {
      forStmtLabel_0: {
        put_0_nifjp9lau1(b_31, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 2561);
          mem.setU32((_o + 4), 0);
          return _o;
        })());
        {
          whileStmtLabel_1: {
            var X60Qlf_18 = 1;
            var X60Qlf_19 = mem.i32((b_31 + 20));
            var X60Qlf_20 = allocFixed(4);
            mem.setI32(X60Qlf_20, X60Qlf_18);
            {
              while ((mem.i32(X60Qlf_20) <= X60Qlf_19)) {
                {
                  put_1_nifjp9lau1(b_31, 32);
                }
                inc_1_I6wjjge_cmdqs323n1(X60Qlf_20);
              }
            }
          }
        }
      }
    }
    put_1_nifjp9lau1(b_31, 40);
  } else {
    put_0_nifjp9lau1(b_31, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 2624002);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
  }
  put_0_nifjp9lau1(b_31, kind_0);
  inc_1_I6wjjge_cmdqs323n1((b_31 + 20));
}

function endTree_0_nifjp9lau1(b_32) {
  if ((!(0 < mem.i32((b_32 + 20))))) {
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1933663230);
      mem.setU32((_o + 4), strlit_0_I14676000009897902695_assy765wm);
      return _o;
    })());
    write_0_syn1lfpjv(stdout, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1852139518);
      mem.setU32((_o + 4), strlit_0_I2857462522550599008_nifjp9lau1);
      return _o;
    })());
    write_7_syn1lfpjv(stdout, 10);
    quit_0_syn1lfpjv(1);
  }
  if ((0 <= mem.i32((b_32 + 20)))) {
    dec_1_I0nzoz91_envto7w6l1((b_32 + 20));
  }
  undoWhitespace_0_nifjp9lau1(b_32);
  put_1_nifjp9lau1(b_32, 41);
}

function addStrLit_1_nifjp9lau1(b_35, s_13, suffix_1, col_5, line_5, file_5) {
  addTree_0_nifjp9lau1(b_35, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1718973187);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  let X60Qx_70;
  let X60Qx_71;
  if ((!(col_5 === 0))) {
    X60Qx_71 = true;
  } else {
    X60Qx_71 = (!(line_5 === 0));
  }
  if (X60Qx_71) {
    X60Qx_70 = true;
  } else {
    let X60Qx_72 = len_4_sysvq0asl(file_5);
    X60Qx_70 = (0 < X60Qx_72);
  }
  if (X60Qx_70) {
    attachLineInfo_1_nifjp9lau1(b_35, col_5, line_5, file_5);
  }
  addStrLit_0_nifjp9lau1(b_35, s_13);
  addStrLit_0_nifjp9lau1(b_35, suffix_1);
  endTree_0_nifjp9lau1(b_35);
}

function addHeader_0_nifjp9lau1(b_36, vendor_0, dialect_0) {
  put_0_nifjp9lau1(b_36, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1848518910);
    mem.setU32((_o + 4), strlit_0_I7652740792648692536_nifjp9lau1);
    return _o;
  })());
  let X60Qx_73 = len_4_sysvq0asl(vendor_0);
  if ((0 < X60Qx_73)) {
    put_0_nifjp9lau1(b_36, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1982736638);
      mem.setU32((_o + 4), strlit_0_I2246750106930142149_nifjp9lau1);
      return _o;
    })());
    addStrLit_0_nifjp9lau1(b_36, vendor_0);
    put_0_nifjp9lau1(b_36, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 665858);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
  }
  let X60Qx_74 = len_4_sysvq0asl(dialect_0);
  if ((0 < X60Qx_74)) {
    put_0_nifjp9lau1(b_36, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1680746750);
      mem.setU32((_o + 4), strlit_0_I15962761803738331083_nifjp9lau1);
      return _o;
    })());
    addStrLit_0_nifjp9lau1(b_36, dialect_0);
    put_0_nifjp9lau1(b_36, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 665858);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
  }
}

function minusQeQ_0_Ipe1u69_nifjp9lau1(x_10, y_3) {
  mem.setI32(x_10, ((mem.i32(x_10) - y_3) | 0));
}

function classify_0_Iva37xy1_nifjp9lau1(x_13) {
  let result_11;
  let X60Qx_77 = allocFixed(8);
  mem.setU32(X60Qx_77, 1852271102);
  mem.setU32((X60Qx_77 + 4), strlit_0_I8031254106179394417_dir38pj6l);
  let r_0 = fpclassify(x_13);
  if ((r_0 === FP_NORMAL)) {
    result_11 = 0;
  } else {
    if ((r_0 === FP_SUBNORMAL)) {
      result_11 = 1;
    } else {
      if ((r_0 === FP_ZERO)) {
        let X60Qx_14;
        let X60Qx_78 = signbit_0_I8usf6p_nifjp9lau1(x_13);
        if (X60Qx_78) {
          X60Qx_14 = 3;
        } else {
          X60Qx_14 = 2;
        }
        result_11 = X60Qx_14;
      } else {
        if ((r_0 === FP_NAN)) {
          result_11 = 4;
        } else {
          if ((r_0 === FP_INFINITE)) {
            let X60Qx_15;
            let X60Qx_79 = signbit_0_I8usf6p_nifjp9lau1(x_13);
            if (X60Qx_79) {
              X60Qx_15 = 6;
            } else {
              X60Qx_15 = 5;
            }
            result_11 = X60Qx_15;
          } else {
            result_11 = 4;
          }
        }
      }
    }
  }
  return result_11;
}

function signbit_0_I8usf6p_nifjp9lau1(x_18) {
  let result_14;
  let X60Qx_81 = allocFixed(8);
  mem.setU32(X60Qx_81, 1852271102);
  mem.setU32((X60Qx_81 + 4), strlit_0_I8031254106179394417_dir38pj6l);
  let X60Qx_82 = signbit(x_18);
  result_14 = (!(X60Qx_82 === 0));
  return result_14;
}

function eQwasmovedQ_SX42uilder0nifjp9lau1_0_nifjp9lau1(dest_0) {
  nimStrWasMoved(dest_0);
  nimStrWasMoved((dest_0 + 12));
}

function eQdestroyQ_SX42uilder0nifjp9lau1_0_nifjp9lau1(dest_0) {
  nimStrDestroy((dest_0 + 12));
  nimStrDestroy(dest_0);
}

let X60QiniGuard_0_nifjp9lau1 = allocFixed(1);

function X60Qini_0_nifjp9lau1() {
  if (mem.u8At(X60QiniGuard_0_nifjp9lau1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_nifjp9lau1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_assy765wm();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_for2ybv4p1();
  X60Qini_0_mat7cnfv21();
  X60Qini_0_str7j0ifg();
  X60Qini_0_vfsc9jn7();
}
// generated by lengc (js backend) from timsagyye1.c.nif

let X60QiniGuard_0_timsagyye1 = allocFixed(1);

function X60Qini_0_timsagyye1() {
  if (mem.u8At(X60QiniGuard_0_timsagyye1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_timsagyye1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_str7j0ifg();
  X60Qini_0_pososrh1q1();
}
// generated by lengc (js backend) from lex3r1urc1.c.nif

function initLexer_0_lex3r1urc1(src_0) {
  let result_0 = allocFixed(28);
  eQwasmovedQ_SX4cexer0lex3r1urc1_0_lex3r1urc1(result_0);
  eQdestroyQ_SX4cexer0lex3r1urc1_0_lex3r1urc1(result_0);
  let X60Qx_13 = allocFixed(8);
  mem.copy(X60Qx_13, nimStrDup(src_0), 8);
  let X60Qx_14 = len_4_sysvq0asl(src_0);
  mem.copy(result_0, (() => {
    let _o = allocFixed(28);
    mem.copy(_o, X60Qx_13, 8);
    mem.setI32((_o + 8), X60Qx_14);
    mem.setI32((_o + 12), 0);
    mem.setI32((_o + 16), 1);
    mem.setI32((_o + 20), 0);
    mem.setU8((_o + 24), true);
    return _o;
  })(), 28);
  return result_0;
}

function cur_0_lex3r1urc1(lx_0) {
  let result_1;
  let X60Qx_0;
  if ((mem.i32((lx_0 + 12)) < mem.i32((lx_0 + 8)))) {
    let X60Qx_15 = getQ_9_sysvq0asl(lx_0, mem.i32((lx_0 + 12)));
    X60Qx_0 = X60Qx_15;
  } else {
    X60Qx_0 = 0;
  }
  result_1 = X60Qx_0;
  return result_1;
}

function peek_0_lex3r1urc1(lx_1, k_0) {
  let result_2;
  let p_0 = ((mem.i32((lx_1 + 12)) + k_0) | 0);
  let X60Qx_1;
  if ((p_0 < mem.i32((lx_1 + 8)))) {
    let X60Qx_16 = getQ_9_sysvq0asl(lx_1, p_0);
    X60Qx_1 = X60Qx_16;
  } else {
    X60Qx_1 = 0;
  }
  result_2 = X60Qx_1;
  return result_2;
}

function advance_0_lex3r1urc1(lx_2) {
  if ((mem.i32((lx_2 + 12)) < mem.i32((lx_2 + 8)))) {
    let X60Qx_17 = getQ_9_sysvq0asl(lx_2, mem.i32((lx_2 + 12)));
    if ((X60Qx_17 === 10)) {
      inc_1_I6wjjge_cmdqs323n1((lx_2 + 16));
      mem.setI32((lx_2 + 20), 0);
      mem.setU8((lx_2 + 24), true);
    } else {
      inc_1_I6wjjge_cmdqs323n1((lx_2 + 20));
    }
    inc_1_I6wjjge_cmdqs323n1((lx_2 + 12));
  }
}

function isIdentStart_0_lex3r1urc1(c_0) {
  let result_3;
  let X60Qx_18;
  let X60Qx_19;
  if ((c_0 === 95)) {
    X60Qx_19 = true;
  } else {
    let X60Qx_20;
    if ((97 <= c_0)) {
      X60Qx_20 = (c_0 <= 122);
    } else {
      X60Qx_20 = false;
    }
    X60Qx_19 = X60Qx_20;
  }
  if (X60Qx_19) {
    X60Qx_18 = true;
  } else {
    let X60Qx_21;
    if ((65 <= c_0)) {
      X60Qx_21 = (c_0 <= 90);
    } else {
      X60Qx_21 = false;
    }
    X60Qx_18 = X60Qx_21;
  }
  result_3 = X60Qx_18;
  return result_3;
}

function isIdentCont_0_lex3r1urc1(c_1) {
  let result_4;
  let X60Qx_22;
  let X60Qx_23 = isIdentStart_0_lex3r1urc1(c_1);
  if (X60Qx_23) {
    X60Qx_22 = true;
  } else {
    let X60Qx_24;
    if ((48 <= c_1)) {
      X60Qx_24 = (c_1 <= 57);
    } else {
      X60Qx_24 = false;
    }
    X60Qx_22 = X60Qx_24;
  }
  result_4 = X60Qx_22;
  return result_4;
}

function isDigit_0_lex3r1urc1(c_2) {
  let result_5;
  let X60Qx_25;
  if ((48 <= c_2)) {
    X60Qx_25 = (c_2 <= 57);
  } else {
    X60Qx_25 = false;
  }
  result_5 = X60Qx_25;
  return result_5;
}

function isHexDigit_0_lex3r1urc1(c_3) {
  let result_6;
  let X60Qx_26;
  let X60Qx_27;
  let X60Qx_28 = isDigit_0_lex3r1urc1(c_3);
  if (X60Qx_28) {
    X60Qx_27 = true;
  } else {
    let X60Qx_29;
    if ((97 <= c_3)) {
      X60Qx_29 = (c_3 <= 102);
    } else {
      X60Qx_29 = false;
    }
    X60Qx_27 = X60Qx_29;
  }
  if (X60Qx_27) {
    X60Qx_26 = true;
  } else {
    let X60Qx_30;
    if ((65 <= c_3)) {
      X60Qx_30 = (c_3 <= 70);
    } else {
      X60Qx_30 = false;
    }
    X60Qx_26 = X60Qx_30;
  }
  result_6 = X60Qx_26;
  return result_6;
}

function hexVal_0_lex3r1urc1(c_4) {
  let result_7;
  let X60Qx_2;
  let X60Qx_31;
  if ((48 <= c_4)) {
    X60Qx_31 = (c_4 <= 57);
  } else {
    X60Qx_31 = false;
  }
  if (X60Qx_31) {
    X60Qx_2 = ((c_4 - 48) | 0);
  } else {
    let X60Qx_32;
    if ((97 <= c_4)) {
      X60Qx_32 = (c_4 <= 102);
    } else {
      X60Qx_32 = false;
    }
    if (X60Qx_32) {
      X60Qx_2 = ((((c_4 - 97) | 0) + 10) | 0);
    } else {
      let X60Qx_33;
      if ((65 <= c_4)) {
        X60Qx_33 = (c_4 <= 70);
      } else {
        X60Qx_33 = false;
      }
      if (X60Qx_33) {
        X60Qx_2 = ((((c_4 - 65) | 0) + 10) | 0);
      } else {
        X60Qx_2 = -1;
      }
    }
  }
  result_7 = X60Qx_2;
  return result_7;
}

function startToken_0_lex3r1urc1(lx_3, kind_0) {
  let result_8 = allocFixed(72);
  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_8);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_8);
  let X60Qx_34 = allocFixed(72);
  mem.copy(X60Qx_34, initToken_0_tok9e79hf(kind_0, mem.i32((lx_3 + 16)), mem.i32((lx_3 + 20))), 72);
  mem.copy(result_8, X60Qx_34, 72);
  if (mem.u8At((lx_3 + 24))) {
    mem.setI32((result_8 + 52), mem.i32((lx_3 + 20)));
  }
  return result_8;
}

function addUtf8_0_lex3r1urc1(s_0, cp_0) {
  let i_0 = cp_0;
  if ((i_0 <= 127)) {
    let X60Qx_35 = chr_0_sysvq0asl((i_0 & 255));
    add_1_sysvq0asl(s_0, X60Qx_35);
  } else {
    if ((i_0 <= 2047)) {
      let X60Qx_36 = chr_0_sysvq0asl(((i_0 >> 6) | 192));
      add_1_sysvq0asl(s_0, X60Qx_36);
      let X60Qx_37 = chr_0_sysvq0asl(((i_0 & 63) | 128));
      add_1_sysvq0asl(s_0, X60Qx_37);
    } else {
      if ((i_0 <= 65535)) {
        let X60Qx_38 = chr_0_sysvq0asl(((i_0 >> 12) | 224));
        add_1_sysvq0asl(s_0, X60Qx_38);
        let X60Qx_39 = chr_0_sysvq0asl((((i_0 >> 6) & 63) | 128));
        add_1_sysvq0asl(s_0, X60Qx_39);
        let X60Qx_40 = chr_0_sysvq0asl(((i_0 & 63) | 128));
        add_1_sysvq0asl(s_0, X60Qx_40);
      } else {
        let X60Qx_41 = chr_0_sysvq0asl(((i_0 >> 18) | 240));
        add_1_sysvq0asl(s_0, X60Qx_41);
        let X60Qx_42 = chr_0_sysvq0asl((((i_0 >> 12) & 63) | 128));
        add_1_sysvq0asl(s_0, X60Qx_42);
        let X60Qx_43 = chr_0_sysvq0asl((((i_0 >> 6) & 63) | 128));
        add_1_sysvq0asl(s_0, X60Qx_43);
        let X60Qx_44 = chr_0_sysvq0asl(((i_0 & 63) | 128));
        add_1_sysvq0asl(s_0, X60Qx_44);
      }
    }
  }
}

function decodeEscape_0_lex3r1urc1(lx_4, s_1) {
  advance_0_lex3r1urc1(lx_4);
  var c_5 = cur_0_lex3r1urc1(lx_4);
  {
    var $csel0 = c_5;
    if ((($csel0 === 110) || ($csel0 === 78))) {
      add_1_sysvq0asl(s_1, 10);
      advance_0_lex3r1urc1(lx_4);
    } else if ((($csel0 === 112) || ($csel0 === 80))) {
      add_1_sysvq0asl(s_1, 10);
      advance_0_lex3r1urc1(lx_4);
    } else if ((($csel0 === 114) || (($csel0 === 82) || (($csel0 === 99) || ($csel0 === 67))))) {
      add_1_sysvq0asl(s_1, 13);
      advance_0_lex3r1urc1(lx_4);
    } else if ((($csel0 === 108) || ($csel0 === 76))) {
      add_1_sysvq0asl(s_1, 10);
      advance_0_lex3r1urc1(lx_4);
    } else if ((($csel0 === 102) || ($csel0 === 70))) {
      add_1_sysvq0asl(s_1, 12);
      advance_0_lex3r1urc1(lx_4);
    } else if ((($csel0 === 101) || ($csel0 === 69))) {
      add_1_sysvq0asl(s_1, 27);
      advance_0_lex3r1urc1(lx_4);
    } else if ((($csel0 === 97) || ($csel0 === 65))) {
      add_1_sysvq0asl(s_1, 7);
      advance_0_lex3r1urc1(lx_4);
    } else if ((($csel0 === 98) || ($csel0 === 66))) {
      add_1_sysvq0asl(s_1, 8);
      advance_0_lex3r1urc1(lx_4);
    } else if ((($csel0 === 118) || ($csel0 === 86))) {
      add_1_sysvq0asl(s_1, 11);
      advance_0_lex3r1urc1(lx_4);
    } else if ((($csel0 === 116) || ($csel0 === 84))) {
      add_1_sysvq0asl(s_1, 9);
      advance_0_lex3r1urc1(lx_4);
    } else if ((($csel0 === 39) || (($csel0 === 34) || ($csel0 === 92)))) {
      add_1_sysvq0asl(s_1, c_5);
      advance_0_lex3r1urc1(lx_4);
    } else if ((($csel0 === 120) || ($csel0 === 88))) {
      whileStmtLabel_0: {
        advance_0_lex3r1urc1(lx_4);
        var xi_0 = 0;
        var k_1 = allocFixed(4);
        mem.setI32(k_1, 0);
        {
          while (true) {
            var X60Qx_45;
            if ((mem.i32(k_1) < 2)) {
              var X60Qx_46 = cur_0_lex3r1urc1(lx_4);
              var X60Qx_47 = isHexDigit_0_lex3r1urc1(X60Qx_46);
              X60Qx_45 = X60Qx_47;
            } else {
              X60Qx_45 = false;
            }
            if (X60Qx_45) {
              var X60Qx_48 = cur_0_lex3r1urc1(lx_4);
              var X60Qx_49 = hexVal_0_lex3r1urc1(X60Qx_48);
              xi_0 = ((xi_0 << 4) | X60Qx_49);
              advance_0_lex3r1urc1(lx_4);
              inc_1_I6wjjge_cmdqs323n1(k_1);
            } else {
              break;
            }
          }
        }
      }
      var X60Qx_50 = chr_0_sysvq0asl((xi_0 & 255));
      add_1_sysvq0asl(s_1, X60Qx_50);
    } else if ((($csel0 === 117) || ($csel0 === 85))) {
      advance_0_lex3r1urc1(lx_4);
      var xi_1 = 0;
      var X60Qx_51 = cur_0_lex3r1urc1(lx_4);
      if ((X60Qx_51 === 123)) {
        whileStmtLabel_1: {
          advance_0_lex3r1urc1(lx_4);
          {
            while (true) {
              var X60Qx_52;
              var X60Qx_53 = cur_0_lex3r1urc1(lx_4);
              if ((!(X60Qx_53 === 125))) {
                X60Qx_52 = (mem.i32((lx_4 + 12)) < mem.i32((lx_4 + 8)));
              } else {
                X60Qx_52 = false;
              }
              if (X60Qx_52) {
                var X60Qx_54 = cur_0_lex3r1urc1(lx_4);
                var X60Qx_55 = isHexDigit_0_lex3r1urc1(X60Qx_54);
                if (X60Qx_55) {
                  var X60Qx_56 = cur_0_lex3r1urc1(lx_4);
                  var X60Qx_57 = hexVal_0_lex3r1urc1(X60Qx_56);
                  xi_1 = ((xi_1 << 4) | X60Qx_57);
                }
                advance_0_lex3r1urc1(lx_4);
              } else {
                break;
              }
            }
          }
        }
        var X60Qx_58 = cur_0_lex3r1urc1(lx_4);
        if ((X60Qx_58 === 125)) {
          advance_0_lex3r1urc1(lx_4);
        }
      } else {
        whileStmtLabel_2: {
          var k_2 = allocFixed(4);
          mem.setI32(k_2, 0);
          {
            while (true) {
              var X60Qx_59;
              if ((mem.i32(k_2) < 4)) {
                var X60Qx_60 = cur_0_lex3r1urc1(lx_4);
                var X60Qx_61 = isHexDigit_0_lex3r1urc1(X60Qx_60);
                X60Qx_59 = X60Qx_61;
              } else {
                X60Qx_59 = false;
              }
              if (X60Qx_59) {
                var X60Qx_62 = cur_0_lex3r1urc1(lx_4);
                var X60Qx_63 = hexVal_0_lex3r1urc1(X60Qx_62);
                xi_1 = ((xi_1 << 4) | X60Qx_63);
                advance_0_lex3r1urc1(lx_4);
                inc_1_I6wjjge_cmdqs323n1(k_2);
              } else {
                break;
              }
            }
          }
        }
      }
      addUtf8_0_lex3r1urc1(s_1, xi_1);
    } else if ((($csel0 >= 48) && ($csel0 <= 57))) {
      whileStmtLabel_3: {
        var xi_2 = 0;
        {
          while (true) {
            var X60Qx_64 = cur_0_lex3r1urc1(lx_4);
            var X60Qx_65 = isDigit_0_lex3r1urc1(X60Qx_64);
            if (X60Qx_65) {
              var X60Qx_66 = cur_0_lex3r1urc1(lx_4);
              xi_2 = ((Math.imul(xi_2, 10) + ((X60Qx_66 - 48) | 0)) | 0);
              advance_0_lex3r1urc1(lx_4);
            } else {
              break;
            }
          }
        }
      }
      var X60Qx_67 = chr_0_sysvq0asl((xi_2 & 255));
      add_1_sysvq0asl(s_1, X60Qx_67);
    } else {
      if ((mem.i32((lx_4 + 12)) < mem.i32((lx_4 + 8)))) {
        add_1_sysvq0asl(s_1, c_5);
        advance_0_lex3r1urc1(lx_4);
      }
    }
  }
}

function lexTripleString_0_lex3r1urc1(lx_5, raw_0) {
  whileStmtLabel_1: {
    var result_9 = allocFixed(72);
    eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_9);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_9);
    var X60Qx_68 = allocFixed(72);
    mem.copy(X60Qx_68, startToken_0_lex3r1urc1(lx_5, 7), 72);
    mem.copy(result_9, X60Qx_68, 72);
    advance_0_lex3r1urc1(lx_5);
    advance_0_lex3r1urc1(lx_5);
    advance_0_lex3r1urc1(lx_5);
    var X60Qx_69;
    var X60Qx_70 = cur_0_lex3r1urc1(lx_5);
    if ((X60Qx_70 === 32)) {
      X60Qx_69 = true;
    } else {
      var X60Qx_71 = cur_0_lex3r1urc1(lx_5);
      X60Qx_69 = (X60Qx_71 === 9);
    }
    if (X60Qx_69) {
      whileStmtLabel_0: {
        var save_0 = allocFixed(28);
        mem.copy(save_0, eQdupQ_SX4cexer0lex3r1urc1_0_lex3r1urc1(lx_5), 28);
        {
          while (true) {
            var X60Qx_72;
            var X60Qx_73 = cur_0_lex3r1urc1(lx_5);
            if ((X60Qx_73 === 32)) {
              X60Qx_72 = true;
            } else {
              var X60Qx_74 = cur_0_lex3r1urc1(lx_5);
              X60Qx_72 = (X60Qx_74 === 9);
            }
            if (X60Qx_72) {
              advance_0_lex3r1urc1(lx_5);
            } else {
              break;
            }
          }
        }
      }
      var X60Qx_75;
      var X60Qx_76 = cur_0_lex3r1urc1(lx_5);
      if ((X60Qx_76 === 13)) {
        X60Qx_75 = true;
      } else {
        var X60Qx_77 = cur_0_lex3r1urc1(lx_5);
        X60Qx_75 = (X60Qx_77 === 10);
      }
      if (X60Qx_75) {
      } else {
        eQdestroyQ_SX4cexer0lex3r1urc1_0_lex3r1urc1(lx_5);
        mem.copy(lx_5, save_0, 28);
        eQwasmovedQ_SX4cexer0lex3r1urc1_0_lex3r1urc1(save_0);
      }
      eQdestroyQ_SX4cexer0lex3r1urc1_0_lex3r1urc1(save_0);
    }
    var X60Qx_78 = cur_0_lex3r1urc1(lx_5);
    if ((X60Qx_78 === 13)) {
      advance_0_lex3r1urc1(lx_5);
      var X60Qx_79 = cur_0_lex3r1urc1(lx_5);
      if ((X60Qx_79 === 10)) {
        advance_0_lex3r1urc1(lx_5);
      }
    } else {
      var X60Qx_80 = cur_0_lex3r1urc1(lx_5);
      if ((X60Qx_80 === 10)) {
        advance_0_lex3r1urc1(lx_5);
      }
    }
    var s_4 = allocFixed(8);
    mem.setU32(s_4, 0);
    mem.setU32((s_4 + 4), 0);
    {
      while ((mem.i32((lx_5 + 12)) < mem.i32((lx_5 + 8)))) {
        var X60Qx_81;
        var X60Qx_82;
        var X60Qx_83;
        var X60Qx_84 = cur_0_lex3r1urc1(lx_5);
        if ((X60Qx_84 === 34)) {
          var X60Qx_85 = peek_0_lex3r1urc1(lx_5, 1);
          X60Qx_83 = (X60Qx_85 === 34);
        } else {
          X60Qx_83 = false;
        }
        if (X60Qx_83) {
          var X60Qx_86 = peek_0_lex3r1urc1(lx_5, 2);
          X60Qx_82 = (X60Qx_86 === 34);
        } else {
          X60Qx_82 = false;
        }
        if (X60Qx_82) {
          var X60Qx_87 = peek_0_lex3r1urc1(lx_5, 3);
          X60Qx_81 = (!(X60Qx_87 === 34));
        } else {
          X60Qx_81 = false;
        }
        if (X60Qx_81) {
          advance_0_lex3r1urc1(lx_5);
          advance_0_lex3r1urc1(lx_5);
          advance_0_lex3r1urc1(lx_5);
          break whileStmtLabel_1;
        } else {
          var X60Qx_88 = cur_0_lex3r1urc1(lx_5);
          if ((X60Qx_88 === 13)) {
            advance_0_lex3r1urc1(lx_5);
            var X60Qx_89 = cur_0_lex3r1urc1(lx_5);
            if ((X60Qx_89 === 10)) {
              advance_0_lex3r1urc1(lx_5);
            }
            add_1_sysvq0asl(s_4, 10);
          } else {
            var X60Qx_90 = cur_0_lex3r1urc1(lx_5);
            if ((X60Qx_90 === 10)) {
              advance_0_lex3r1urc1(lx_5);
              add_1_sysvq0asl(s_4, 10);
            } else {
              var X60Qx_91 = cur_0_lex3r1urc1(lx_5);
              add_1_sysvq0asl(s_4, X60Qx_91);
              advance_0_lex3r1urc1(lx_5);
            }
          }
        }
      }
    }
  }
  var X60Qlhs_0 = (result_9 + 4);
  nimStrDestroy(X60Qlhs_0);
  mem.copy(X60Qlhs_0, s_4, 8);
  nimStrWasMoved(s_4);
  nimStrDestroy(s_4);
  return result_9;
  nimStrDestroy(s_4);
  return result_9;
}

function lexRawString_0_lex3r1urc1(lx_6) {
  whileStmtLabel_0: {
    var result_10 = allocFixed(72);
    eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_10);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_10);
    var X60Qx_92 = allocFixed(72);
    mem.copy(X60Qx_92, startToken_0_lex3r1urc1(lx_6, 6), 72);
    mem.copy(result_10, X60Qx_92, 72);
    advance_0_lex3r1urc1(lx_6);
    var s_5 = allocFixed(8);
    mem.setU32(s_5, 0);
    mem.setU32((s_5 + 4), 0);
    {
      while (true) {
        var X60Qx_93;
        if ((mem.i32((lx_6 + 12)) < mem.i32((lx_6 + 8)))) {
          var X60Qx_94 = cur_0_lex3r1urc1(lx_6);
          X60Qx_93 = (!(X60Qx_94 === 10));
        } else {
          X60Qx_93 = false;
        }
        if (X60Qx_93) {
          var X60Qx_95 = cur_0_lex3r1urc1(lx_6);
          if ((X60Qx_95 === 34)) {
            var X60Qx_96 = peek_0_lex3r1urc1(lx_6, 1);
            if ((X60Qx_96 === 34)) {
              add_1_sysvq0asl(s_5, 34);
              advance_0_lex3r1urc1(lx_6);
              advance_0_lex3r1urc1(lx_6);
            } else {
              advance_0_lex3r1urc1(lx_6);
              break whileStmtLabel_0;
            }
          } else {
            var X60Qx_97 = cur_0_lex3r1urc1(lx_6);
            add_1_sysvq0asl(s_5, X60Qx_97);
            advance_0_lex3r1urc1(lx_6);
          }
        } else {
          break;
        }
      }
    }
  }
  var X60Qlhs_1 = (result_10 + 4);
  nimStrDestroy(X60Qlhs_1);
  mem.copy(X60Qlhs_1, s_5, 8);
  nimStrWasMoved(s_5);
  nimStrDestroy(s_5);
  return result_10;
  nimStrDestroy(s_5);
  return result_10;
}

function lexString_0_lex3r1urc1(lx_7) {
  whileStmtLabel_0: {
    var result_11 = allocFixed(72);
    eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_11);
    var X60Qx_98;
    var X60Qx_99 = peek_0_lex3r1urc1(lx_7, 1);
    if ((X60Qx_99 === 34)) {
      var X60Qx_100 = peek_0_lex3r1urc1(lx_7, 2);
      X60Qx_98 = (X60Qx_100 === 34);
    } else {
      X60Qx_98 = false;
    }
    if (X60Qx_98) {
      var X60Qx_101 = allocFixed(72);
      mem.copy(X60Qx_101, lexTripleString_0_lex3r1urc1(lx_7, false), 72);
      mem.copy(result_11, X60Qx_101, 72);
      return result_11;
    }
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_11);
    var X60Qx_102 = allocFixed(72);
    mem.copy(X60Qx_102, startToken_0_lex3r1urc1(lx_7, 5), 72);
    mem.copy(result_11, X60Qx_102, 72);
    advance_0_lex3r1urc1(lx_7);
    var s_6 = allocFixed(8);
    mem.setU32(s_6, 0);
    mem.setU32((s_6 + 4), 0);
    {
      while (true) {
        var X60Qx_103;
        var X60Qx_104;
        if ((mem.i32((lx_7 + 12)) < mem.i32((lx_7 + 8)))) {
          var X60Qx_105 = cur_0_lex3r1urc1(lx_7);
          X60Qx_104 = (!(X60Qx_105 === 34));
        } else {
          X60Qx_104 = false;
        }
        if (X60Qx_104) {
          var X60Qx_106 = cur_0_lex3r1urc1(lx_7);
          X60Qx_103 = (!(X60Qx_106 === 10));
        } else {
          X60Qx_103 = false;
        }
        if (X60Qx_103) {
          var X60Qx_107 = cur_0_lex3r1urc1(lx_7);
          if ((X60Qx_107 === 92)) {
            decodeEscape_0_lex3r1urc1(lx_7, s_6);
          } else {
            var X60Qx_108 = cur_0_lex3r1urc1(lx_7);
            add_1_sysvq0asl(s_6, X60Qx_108);
            advance_0_lex3r1urc1(lx_7);
          }
        } else {
          break;
        }
      }
    }
  }
  var X60Qx_109 = cur_0_lex3r1urc1(lx_7);
  if ((X60Qx_109 === 34)) {
    advance_0_lex3r1urc1(lx_7);
  }
  var X60Qlhs_2 = (result_11 + 4);
  nimStrDestroy(X60Qlhs_2);
  mem.copy(X60Qlhs_2, s_6, 8);
  nimStrWasMoved(s_6);
  nimStrDestroy(s_6);
  return result_11;
  nimStrDestroy(s_6);
  return result_11;
}

function lexRawOrTriple_0_lex3r1urc1(lx_8) {
  let result_12 = allocFixed(72);
  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_12);
  let anchor_0 = allocFixed(72);
  mem.copy(anchor_0, startToken_0_lex3r1urc1(lx_8, 6), 72);
  advance_0_lex3r1urc1(lx_8);
  let X60Qx_110;
  let X60Qx_111;
  let X60Qx_112 = cur_0_lex3r1urc1(lx_8);
  if ((X60Qx_112 === 34)) {
    let X60Qx_113 = peek_0_lex3r1urc1(lx_8, 1);
    X60Qx_111 = (X60Qx_113 === 34);
  } else {
    X60Qx_111 = false;
  }
  if (X60Qx_111) {
    let X60Qx_114 = peek_0_lex3r1urc1(lx_8, 2);
    X60Qx_110 = (X60Qx_114 === 34);
  } else {
    X60Qx_110 = false;
  }
  if (X60Qx_110) {
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_12);
    let X60Qx_115 = allocFixed(72);
    mem.copy(X60Qx_115, lexTripleString_0_lex3r1urc1(lx_8, true), 72);
    mem.copy(result_12, X60Qx_115, 72);
  } else {
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_12);
    let X60Qx_116 = allocFixed(72);
    mem.copy(X60Qx_116, lexRawString_0_lex3r1urc1(lx_8), 72);
    mem.copy(result_12, X60Qx_116, 72);
  }
  mem.setI32((result_12 + 40), mem.i32((anchor_0 + 40)));
  mem.setI32((result_12 + 44), mem.i32((anchor_0 + 44)));
  mem.setI32((result_12 + 52), mem.i32((anchor_0 + 52)));
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(anchor_0);
  return result_12;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(anchor_0);
  return result_12;
}

function lexChar_0_lex3r1urc1(lx_9) {
  let result_13 = allocFixed(72);
  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_13);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_13);
  let X60Qx_117 = allocFixed(72);
  mem.copy(X60Qx_117, startToken_0_lex3r1urc1(lx_9, 8), 72);
  mem.copy(result_13, X60Qx_117, 72);
  advance_0_lex3r1urc1(lx_9);
  let s_7 = allocFixed(8);
  mem.setU32(s_7, 0);
  mem.setU32((s_7 + 4), 0);
  let X60Qx_118 = cur_0_lex3r1urc1(lx_9);
  if ((X60Qx_118 === 92)) {
    decodeEscape_0_lex3r1urc1(lx_9, s_7);
  } else {
    let X60Qx_119 = cur_0_lex3r1urc1(lx_9);
    add_1_sysvq0asl(s_7, X60Qx_119);
    advance_0_lex3r1urc1(lx_9);
  }
  let X60Qx_120 = cur_0_lex3r1urc1(lx_9);
  if ((X60Qx_120 === 39)) {
    advance_0_lex3r1urc1(lx_9);
  }
  let X60Qx_121 = len_4_sysvq0asl(s_7);
  if ((0 < X60Qx_121)) {
    let X60Qx_122 = getQ_9_sysvq0asl(s_7, 0);
    mem.setI64((result_13 + 16), BigInt(X60Qx_122));
  }
  let X60Qlhs_3 = (result_13 + 4);
  nimStrDestroy(X60Qlhs_3);
  mem.copy(X60Qlhs_3, s_7, 8);
  nimStrWasMoved(s_7);
  nimStrDestroy(s_7);
  return result_13;
  nimStrDestroy(s_7);
  return result_13;
}

function decodeIntBase_0_lex3r1urc1(digits_0, base_0) {
  var result_14;
  result_14 = 0n;
  switch (base_0) {
    case 16:
      {
        forStmtLabel_0: {
          {
            whileStmtLabel_1: {
              var X60Qlf_0 = allocFixed(8);
              mem.copy(X60Qlf_0, toOpenArray_2_sysvq0asl(digits_0), 8);
              var X60Qlf_1 = allocFixed(4);
              mem.setI32(X60Qlf_1, 0);
              {
                while (true) {
                  var X60Qx_123 = len_6_Iroq7kd1_has9tn57v(X60Qlf_0);
                  if ((mem.i32(X60Qlf_1) < X60Qx_123)) {
                    {
                      var X60Qii_2 = getQ_10_I5nt6we_has9tn57v(X60Qlf_0, mem.i32(X60Qlf_1));
                      var X60Qx_124 = hexVal_0_lex3r1urc1(mem.u8At(X60Qii_2));
                      result_14 = (BigInt.asIntN(64, (result_14 << 4n)) | BigInt(X60Qx_124));
                    }
                    inc_1_I6wjjge_cmdqs323n1(X60Qlf_1);
                  } else {
                    break;
                  }
                }
              }
            }
          }
        }
      }
      break;
    case 8:
      {
        forStmtLabel_3: {
          {
            whileStmtLabel_4: {
              var X60Qlf_2 = allocFixed(8);
              mem.copy(X60Qlf_2, toOpenArray_2_sysvq0asl(digits_0), 8);
              var X60Qlf_3 = allocFixed(4);
              mem.setI32(X60Qlf_3, 0);
              {
                while (true) {
                  var X60Qx_125 = len_6_Iroq7kd1_has9tn57v(X60Qlf_2);
                  if ((mem.i32(X60Qlf_3) < X60Qx_125)) {
                    {
                      var X60Qii_5 = getQ_10_I5nt6we_has9tn57v(X60Qlf_2, mem.i32(X60Qlf_3));
                      result_14 = (BigInt.asIntN(64, (result_14 << 3n)) | BigInt(((mem.u8At(X60Qii_5) - 48) | 0)));
                    }
                    inc_1_I6wjjge_cmdqs323n1(X60Qlf_3);
                  } else {
                    break;
                  }
                }
              }
            }
          }
        }
      }
      break;
    case 2:
      {
        forStmtLabel_6: {
          {
            whileStmtLabel_7: {
              var X60Qlf_4 = allocFixed(8);
              mem.copy(X60Qlf_4, toOpenArray_2_sysvq0asl(digits_0), 8);
              var X60Qlf_5 = allocFixed(4);
              mem.setI32(X60Qlf_5, 0);
              {
                while (true) {
                  var X60Qx_126 = len_6_Iroq7kd1_has9tn57v(X60Qlf_4);
                  if ((mem.i32(X60Qlf_5) < X60Qx_126)) {
                    {
                      var X60Qii_8 = getQ_10_I5nt6we_has9tn57v(X60Qlf_4, mem.i32(X60Qlf_5));
                      result_14 = (BigInt.asIntN(64, (result_14 << 1n)) | BigInt(((mem.u8At(X60Qii_8) - 48) | 0)));
                    }
                    inc_1_I6wjjge_cmdqs323n1(X60Qlf_5);
                  } else {
                    break;
                  }
                }
              }
            }
          }
        }
      }
      break;
    default:
      {
        forStmtLabel_9: {
          {
            whileStmtLabel_10: {
              var X60Qlf_6 = allocFixed(8);
              mem.copy(X60Qlf_6, toOpenArray_2_sysvq0asl(digits_0), 8);
              var X60Qlf_7 = allocFixed(4);
              mem.setI32(X60Qlf_7, 0);
              {
                while (true) {
                  var X60Qx_127 = len_6_Iroq7kd1_has9tn57v(X60Qlf_6);
                  if ((mem.i32(X60Qlf_7) < X60Qx_127)) {
                    {
                      var X60Qii_11 = getQ_10_I5nt6we_has9tn57v(X60Qlf_6, mem.i32(X60Qlf_7));
                      result_14 = BigInt.asIntN(64, (BigInt.asIntN(64, (result_14 * 10n)) + BigInt(((mem.u8At(X60Qii_11) - 48) | 0))));
                    }
                    inc_1_I6wjjge_cmdqs323n1(X60Qlf_7);
                  } else {
                    break;
                  }
                }
              }
            }
          }
        }
      }
      break;
  }
  return result_14;
}

function parseFloatStr_0_lex3r1urc1(s_2) {
  let result_15;
  let f_0 = allocFixed(8);
  mem.setF64(f_0, 0.0);
  let X60Qx_128 = allocFixed(8);
  mem.copy(X60Qx_128, toOpenArray_2_sysvq0asl(s_2), 8);
  let X60Qx_129 = parseBiggestFloat_0_party5a2l1(X60Qx_128, f_0);
  result_15 = mem.f64(f_0);
  return result_15;
}

function canonFloatSuffix_0_lex3r1urc1(s_3) {
  X60Qsc_8: {
    X60Qsc_9: {
      X60Qsc_2: {
        X60Qsc_1: {
          X60Qsc_0: {
            var result_16 = allocFixed(8);
            nimStrWasMoved(result_16);
            var X60Qx_3 = allocFixed(8);
            nimStrWasMoved(X60Qx_3);
            var X60Qtc_3 = nimStrAtLe_0_sysvq0asl(s_3, 0, 70);
            if (X60Qtc_3) {
              var X60Qtc_4 = nimStrAtLe_0_sysvq0asl(s_3, 1, 51);
              if (X60Qtc_4) {
                if (equalStrings_0_sysvq0asl(s_3, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 842221059);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })())) {
                  break X60Qsc_0;
                } else if (equalStrings_0_sysvq0asl(s_3, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 842090238);
                  mem.setU32((_o + 4), strlit_0_I14798179864757096681_lex3r1urc1);
                  return _o;
                })())) {
                  break X60Qsc_2;
                }
              } else {
                var X60Qtc_5 = nimStrAtLe_0_sysvq0asl(s_3, 0, 68);
                if (X60Qtc_5) {
                  if (equalStrings_0_sysvq0asl(s_3, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 17409);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_1;
                  }
                } else {
                  if (equalStrings_0_sysvq0asl(s_3, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 17921);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_0;
                  } else if (equalStrings_0_sysvq0asl(s_3, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 875972099);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_1;
                  }
                }
              }
            } else {
              var X60Qtc_6 = nimStrAtLe_0_sysvq0asl(s_3, 1, 51);
              if (X60Qtc_6) {
                if (equalStrings_0_sysvq0asl(s_3, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 842229251);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })())) {
                  break X60Qsc_0;
                } else if (equalStrings_0_sysvq0asl(s_3, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 842098430);
                  mem.setU32((_o + 4), strlit_0_I16254591112882230105_lex3r1urc1);
                  return _o;
                })())) {
                  break X60Qsc_2;
                }
              } else {
                var X60Qtc_7 = nimStrAtLe_0_sysvq0asl(s_3, 0, 100);
                if (X60Qtc_7) {
                  if (equalStrings_0_sysvq0asl(s_3, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 25601);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_1;
                  }
                } else {
                  if (equalStrings_0_sysvq0asl(s_3, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 26113);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_0;
                  } else if (equalStrings_0_sysvq0asl(s_3, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 875980291);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_1;
                  }
                }
              }
            }
            break X60Qsc_9;
          }
          nimStrDestroy(X60Qx_3);
          mem.copy(X60Qx_3, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 842229251);
            mem.setU32((_o + 4), 0);
            return _o;
          })(), 8);
          break X60Qsc_8;
        }
        nimStrDestroy(X60Qx_3);
        mem.copy(X60Qx_3, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 875980291);
          mem.setU32((_o + 4), 0);
          return _o;
        })(), 8);
        break X60Qsc_8;
      }
      nimStrDestroy(X60Qx_3);
      mem.copy(X60Qx_3, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 842098430);
        mem.setU32((_o + 4), strlit_0_I16254591112882230105_lex3r1urc1);
        return _o;
      })(), 8);
      break X60Qsc_8;
    }
    nimStrDestroy(X60Qx_3);
    var X60Qx_130 = allocFixed(8);
    mem.copy(X60Qx_130, nimStrDup(s_3), 8);
    mem.copy(X60Qx_3, X60Qx_130, 8);
  }
  nimStrDestroy(result_16);
  mem.copy(result_16, X60Qx_3, 8);
  nimStrWasMoved(X60Qx_3);
  nimStrDestroy(X60Qx_3);
  return result_16;
  nimStrDestroy(X60Qx_3);
  return result_16;
}

function lexNumber_0_lex3r1urc1(lx_10) {
  suffixScan_0: {
    var result_17 = allocFixed(72);
    eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_17);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_17);
    var X60Qx_131 = allocFixed(72);
    mem.copy(X60Qx_131, startToken_0_lex3r1urc1(lx_10, 3), 72);
    mem.copy(result_17, X60Qx_131, 72);
    var base_1 = 10;
    var digits_1 = allocFixed(8);
    mem.setU32(digits_1, 0);
    mem.setU32((digits_1 + 4), 0);
    var floatText_0 = allocFixed(8);
    mem.setU32(floatText_0, 0);
    mem.setU32((floatText_0 + 4), 0);
    var isFloat_0 = false;
    var X60Qx_4;
    var X60Qx_132 = cur_0_lex3r1urc1(lx_10);
    if ((X60Qx_132 === 48)) {
      var X60Qdesugar_0 = allocFixed(32);
      mem.setU8(X60Qdesugar_0, 0);
      mem.setU8((X60Qdesugar_0 + 1), 0);
      mem.setU8((X60Qdesugar_0 + 2), 0);
      mem.setU8((X60Qdesugar_0 + 3), 0);
      mem.setU8((X60Qdesugar_0 + 4), 0);
      mem.setU8((X60Qdesugar_0 + 5), 0);
      mem.setU8((X60Qdesugar_0 + 6), 0);
      mem.setU8((X60Qdesugar_0 + 7), 0);
      mem.setU8((X60Qdesugar_0 + 8), 12);
      mem.setU8((X60Qdesugar_0 + 9), 0);
      mem.setU8((X60Qdesugar_0 + 10), 0);
      mem.setU8((X60Qdesugar_0 + 11), 1);
      mem.setU8((X60Qdesugar_0 + 12), 12);
      mem.setU8((X60Qdesugar_0 + 13), 128);
      mem.setU8((X60Qdesugar_0 + 14), 0);
      mem.setU8((X60Qdesugar_0 + 15), 1);
      mem.setU8((X60Qdesugar_0 + 16), 0);
      mem.setU8((X60Qdesugar_0 + 17), 0);
      mem.setU8((X60Qdesugar_0 + 18), 0);
      mem.setU8((X60Qdesugar_0 + 19), 0);
      mem.setU8((X60Qdesugar_0 + 20), 0);
      mem.setU8((X60Qdesugar_0 + 21), 0);
      mem.setU8((X60Qdesugar_0 + 22), 0);
      mem.setU8((X60Qdesugar_0 + 23), 0);
      mem.setU8((X60Qdesugar_0 + 24), 0);
      mem.setU8((X60Qdesugar_0 + 25), 0);
      mem.setU8((X60Qdesugar_0 + 26), 0);
      mem.setU8((X60Qdesugar_0 + 27), 0);
      mem.setU8((X60Qdesugar_0 + 28), 0);
      mem.setU8((X60Qdesugar_0 + 29), 0);
      mem.setU8((X60Qdesugar_0 + 30), 0);
      mem.setU8((X60Qdesugar_0 + 31), 0);
      var X60Qx_133 = peek_0_lex3r1urc1(lx_10, 1);
      var X60Qdesugar_1 = X60Qx_133;
      X60Qx_4 = (((mem.u8At((X60Qdesugar_0 + (X60Qdesugar_1 >>> 3))) & ((1 << ((X60Qdesugar_1 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
    } else {
      X60Qx_4 = false;
    }
    if (X60Qx_4) {
      whileStmtLabel_0: {
        var b_0 = peek_0_lex3r1urc1(lx_10, 1);
        advance_0_lex3r1urc1(lx_10);
        advance_0_lex3r1urc1(lx_10);
        switch (b_0) {
          case 120:
          case 88:
            {
              base_1 = 16;
            }
            break;
          case 111:
            {
              base_1 = 8;
            }
            break;
          case 99:
          case 67:
            {
              base_1 = 8;
            }
            break;
          case 98:
          case 66:
            {
              base_1 = 2;
            }
            break;
          default:
            {
            }
            break;
        }
        {
          while (true) {
            var c_10 = cur_0_lex3r1urc1(lx_10);
            if ((c_10 === 95)) {
              advance_0_lex3r1urc1(lx_10);
            } else {
              var X60Qx_134;
              var X60Qx_135;
              var X60Qx_136;
              if ((base_1 === 16)) {
                var X60Qx_137 = isHexDigit_0_lex3r1urc1(c_10);
                X60Qx_136 = X60Qx_137;
              } else {
                X60Qx_136 = false;
              }
              if (X60Qx_136) {
                X60Qx_135 = true;
              } else {
                var X60Qx_138;
                var X60Qx_139;
                if ((base_1 === 8)) {
                  X60Qx_139 = (48 <= c_10);
                } else {
                  X60Qx_139 = false;
                }
                if (X60Qx_139) {
                  X60Qx_138 = (c_10 <= 55);
                } else {
                  X60Qx_138 = false;
                }
                X60Qx_135 = X60Qx_138;
              }
              if (X60Qx_135) {
                X60Qx_134 = true;
              } else {
                var X60Qx_140;
                if ((base_1 === 2)) {
                  var X60Qx_141;
                  if ((c_10 === 48)) {
                    X60Qx_141 = true;
                  } else {
                    X60Qx_141 = (c_10 === 49);
                  }
                  X60Qx_140 = X60Qx_141;
                } else {
                  X60Qx_140 = false;
                }
                X60Qx_134 = X60Qx_140;
              }
              if (X60Qx_134) {
                add_1_sysvq0asl(digits_1, c_10);
                advance_0_lex3r1urc1(lx_10);
              } else {
                break whileStmtLabel_0;
              }
            }
          }
        }
      }
    } else {
      whileStmtLabel_1: {
        {
          while (true) {
            var X60Qx_142 = cur_0_lex3r1urc1(lx_10);
            var X60Qx_143 = isDigit_0_lex3r1urc1(X60Qx_142);
            if (X60Qx_143) {
              var X60Qx_144 = cur_0_lex3r1urc1(lx_10);
              add_1_sysvq0asl(digits_1, X60Qx_144);
              var X60Qx_145 = cur_0_lex3r1urc1(lx_10);
              add_1_sysvq0asl(floatText_0, X60Qx_145);
              advance_0_lex3r1urc1(lx_10);
            } else {
              var X60Qx_146 = cur_0_lex3r1urc1(lx_10);
              if ((X60Qx_146 === 95)) {
                advance_0_lex3r1urc1(lx_10);
              } else {
                break whileStmtLabel_1;
              }
            }
          }
        }
      }
      var X60Qx_147;
      var X60Qx_148 = cur_0_lex3r1urc1(lx_10);
      if ((X60Qx_148 === 46)) {
        var X60Qx_149 = peek_0_lex3r1urc1(lx_10, 1);
        var X60Qx_150 = isDigit_0_lex3r1urc1(X60Qx_149);
        X60Qx_147 = X60Qx_150;
      } else {
        X60Qx_147 = false;
      }
      if (X60Qx_147) {
        whileStmtLabel_2: {
          isFloat_0 = true;
          add_1_sysvq0asl(floatText_0, 46);
          advance_0_lex3r1urc1(lx_10);
          {
            while (true) {
              var X60Qx_151 = cur_0_lex3r1urc1(lx_10);
              var X60Qx_152 = isDigit_0_lex3r1urc1(X60Qx_151);
              if (X60Qx_152) {
                var X60Qx_153 = cur_0_lex3r1urc1(lx_10);
                add_1_sysvq0asl(floatText_0, X60Qx_153);
                advance_0_lex3r1urc1(lx_10);
              } else {
                var X60Qx_154 = cur_0_lex3r1urc1(lx_10);
                if ((X60Qx_154 === 95)) {
                  advance_0_lex3r1urc1(lx_10);
                } else {
                  break whileStmtLabel_2;
                }
              }
            }
          }
        }
      }
      var X60Qx_155;
      var X60Qx_156 = cur_0_lex3r1urc1(lx_10);
      if ((X60Qx_156 === 101)) {
        X60Qx_155 = true;
      } else {
        var X60Qx_157 = cur_0_lex3r1urc1(lx_10);
        X60Qx_155 = (X60Qx_157 === 69);
      }
      if (X60Qx_155) {
        whileStmtLabel_3: {
          isFloat_0 = true;
          add_1_sysvq0asl(floatText_0, 101);
          advance_0_lex3r1urc1(lx_10);
          var X60Qx_158;
          var X60Qx_159 = cur_0_lex3r1urc1(lx_10);
          if ((X60Qx_159 === 43)) {
            X60Qx_158 = true;
          } else {
            var X60Qx_160 = cur_0_lex3r1urc1(lx_10);
            X60Qx_158 = (X60Qx_160 === 45);
          }
          if (X60Qx_158) {
            var X60Qx_161 = cur_0_lex3r1urc1(lx_10);
            add_1_sysvq0asl(floatText_0, X60Qx_161);
            advance_0_lex3r1urc1(lx_10);
          }
          {
            while (true) {
              var X60Qx_162 = cur_0_lex3r1urc1(lx_10);
              var X60Qx_163 = isDigit_0_lex3r1urc1(X60Qx_162);
              if (X60Qx_163) {
                var X60Qx_164 = cur_0_lex3r1urc1(lx_10);
                add_1_sysvq0asl(floatText_0, X60Qx_164);
                advance_0_lex3r1urc1(lx_10);
              } else {
                var X60Qx_165 = cur_0_lex3r1urc1(lx_10);
                if ((X60Qx_165 === 95)) {
                  advance_0_lex3r1urc1(lx_10);
                } else {
                  break whileStmtLabel_3;
                }
              }
            }
          }
        }
      }
    }
    var suffix_0 = allocFixed(8);
    mem.setU32(suffix_0, 0);
    mem.setU32((suffix_0 + 4), 0);
    {
      whileStmtLabel_4: {
        var hasQQuote_0 = false;
        var X60Qx_166 = cur_0_lex3r1urc1(lx_10);
        if ((X60Qx_166 === 39)) {
          hasQQuote_0 = true;
        } else {
          var X60Qdesugar_2 = allocFixed(32);
          mem.setU8(X60Qdesugar_2, 0);
          mem.setU8((X60Qdesugar_2 + 1), 0);
          mem.setU8((X60Qdesugar_2 + 2), 0);
          mem.setU8((X60Qdesugar_2 + 3), 0);
          mem.setU8((X60Qdesugar_2 + 4), 0);
          mem.setU8((X60Qdesugar_2 + 5), 0);
          mem.setU8((X60Qdesugar_2 + 6), 0);
          mem.setU8((X60Qdesugar_2 + 7), 0);
          mem.setU8((X60Qdesugar_2 + 8), 80);
          mem.setU8((X60Qdesugar_2 + 9), 2);
          mem.setU8((X60Qdesugar_2 + 10), 32);
          mem.setU8((X60Qdesugar_2 + 11), 0);
          mem.setU8((X60Qdesugar_2 + 12), 80);
          mem.setU8((X60Qdesugar_2 + 13), 2);
          mem.setU8((X60Qdesugar_2 + 14), 32);
          mem.setU8((X60Qdesugar_2 + 15), 0);
          mem.setU8((X60Qdesugar_2 + 16), 0);
          mem.setU8((X60Qdesugar_2 + 17), 0);
          mem.setU8((X60Qdesugar_2 + 18), 0);
          mem.setU8((X60Qdesugar_2 + 19), 0);
          mem.setU8((X60Qdesugar_2 + 20), 0);
          mem.setU8((X60Qdesugar_2 + 21), 0);
          mem.setU8((X60Qdesugar_2 + 22), 0);
          mem.setU8((X60Qdesugar_2 + 23), 0);
          mem.setU8((X60Qdesugar_2 + 24), 0);
          mem.setU8((X60Qdesugar_2 + 25), 0);
          mem.setU8((X60Qdesugar_2 + 26), 0);
          mem.setU8((X60Qdesugar_2 + 27), 0);
          mem.setU8((X60Qdesugar_2 + 28), 0);
          mem.setU8((X60Qdesugar_2 + 29), 0);
          mem.setU8((X60Qdesugar_2 + 30), 0);
          mem.setU8((X60Qdesugar_2 + 31), 0);
          var X60Qx_167 = cur_0_lex3r1urc1(lx_10);
          var X60Qdesugar_3 = X60Qx_167;
          if ((!(((mem.u8At((X60Qdesugar_2 + (X60Qdesugar_3 >>> 3))) & ((1 << ((X60Qdesugar_3 & 7) >>> 0)) >>> 0)) >>> 0) !== 0))) {
            break suffixScan_0;
          }
        }
        if (hasQQuote_0) {
          advance_0_lex3r1urc1(lx_10);
        }
        var X60Qx_168 = cur_0_lex3r1urc1(lx_10);
        var X60Qx_169 = isIdentStart_0_lex3r1urc1(X60Qx_168);
        if ((!X60Qx_169)) {
          break suffixScan_0;
        }
        var raw_1 = allocFixed(8);
        mem.setU32(raw_1, 0);
        mem.setU32((raw_1 + 4), 0);
        {
          while (true) {
            var X60Qx_170 = cur_0_lex3r1urc1(lx_10);
            var X60Qx_171 = isIdentCont_0_lex3r1urc1(X60Qx_170);
            if (X60Qx_171) {
              var X60Qx_172 = cur_0_lex3r1urc1(lx_10);
              add_1_sysvq0asl(raw_1, X60Qx_172);
              advance_0_lex3r1urc1(lx_10);
            } else {
              break;
            }
          }
        }
      }
      nimStrDestroy(suffix_0);
      mem.copy(suffix_0, raw_1, 8);
      nimStrWasMoved(raw_1);
      nimStrDestroy(raw_1);
    }
  }
  var sufl_0 = allocFixed(8);
  mem.copy(sufl_0, suffix_0, 8);
  nimStrWasMoved(suffix_0);
  var X60Qx_173;
  var X60Qx_174 = len_4_sysvq0asl(sufl_0);
  if ((0 < X60Qx_174)) {
    var X60Qx_175;
    var X60Qx_176;
    var X60Qx_177;
    var X60Qx_178 = getQ_9_sysvq0asl(sufl_0, 0);
    if ((X60Qx_178 === 102)) {
      X60Qx_177 = true;
    } else {
      var X60Qx_179 = getQ_9_sysvq0asl(sufl_0, 0);
      X60Qx_177 = (X60Qx_179 === 70);
    }
    if (X60Qx_177) {
      X60Qx_176 = true;
    } else {
      var X60Qx_180 = getQ_9_sysvq0asl(sufl_0, 0);
      X60Qx_176 = (X60Qx_180 === 100);
    }
    if (X60Qx_176) {
      X60Qx_175 = true;
    } else {
      var X60Qx_181 = getQ_9_sysvq0asl(sufl_0, 0);
      X60Qx_175 = (X60Qx_181 === 68);
    }
    X60Qx_173 = X60Qx_175;
  } else {
    X60Qx_173 = false;
  }
  if (X60Qx_173) {
    isFloat_0 = true;
    var X60Qlhs_4 = (result_17 + 32);
    nimStrDestroy(X60Qlhs_4);
    var X60Qx_182 = allocFixed(8);
    mem.copy(X60Qx_182, canonFloatSuffix_0_lex3r1urc1(sufl_0), 8);
    mem.copy(X60Qlhs_4, X60Qx_182, 8);
  } else {
    var X60Qx_183 = len_4_sysvq0asl(sufl_0);
    if ((0 < X60Qx_183)) {
      var X60Qlhs_5 = (result_17 + 32);
      nimStrDestroy(X60Qlhs_5);
      mem.copy(X60Qlhs_5, sufl_0, 8);
      nimStrWasMoved(sufl_0);
    }
  }
  if (isFloat_0) {
    mem.setU8(result_17, 4);
    var X60Qx_184 = len_4_sysvq0asl(floatText_0);
    if ((X60Qx_184 === 0)) {
      nimStrDestroy(floatText_0);
      mem.copy(floatText_0, digits_1, 8);
      nimStrWasMoved(digits_1);
    }
    var X60Qx_185 = parseFloatStr_0_lex3r1urc1(floatText_0);
    mem.setF64((result_17 + 24), X60Qx_185);
    var X60Qlhs_6 = (result_17 + 4);
    nimStrDestroy(X60Qlhs_6);
    mem.copy(X60Qlhs_6, floatText_0, 8);
    nimStrWasMoved(floatText_0);
  } else {
    mem.setU8(result_17, 3);
    var X60Qx_186 = decodeIntBase_0_lex3r1urc1(digits_1, base_1);
    mem.setI64((result_17 + 16), X60Qx_186);
    var X60Qlhs_7 = (result_17 + 4);
    nimStrDestroy(X60Qlhs_7);
    mem.copy(X60Qlhs_7, digits_1, 8);
    nimStrWasMoved(digits_1);
  }
  nimStrDestroy(sufl_0);
  nimStrDestroy(suffix_0);
  nimStrDestroy(floatText_0);
  nimStrDestroy(digits_1);
  return result_17;
  nimStrDestroy(sufl_0);
  nimStrDestroy(suffix_0);
  nimStrDestroy(floatText_0);
  nimStrDestroy(digits_1);
  return result_17;
}

function lexOperator_0_lex3r1urc1(lx_11) {
  whileStmtLabel_0: {
    var result_18 = allocFixed(72);
    eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_18);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_18);
    var X60Qx_187 = allocFixed(72);
    mem.copy(X60Qx_187, startToken_0_lex3r1urc1(lx_11, 9), 72);
    mem.copy(result_18, X60Qx_187, 72);
    var s_8 = allocFixed(8);
    mem.setU32(s_8, 0);
    mem.setU32((s_8 + 4), 0);
    {
      while (true) {
        var X60Qx_5;
        if ((mem.i32((lx_11 + 12)) < mem.i32((lx_11 + 8)))) {
          var X60Qdesugar_4 = allocFixed(32);
          mem.copy(X60Qdesugar_4, OperatorChars_0_lex3r1urc1, 32);
          var X60Qx_188 = cur_0_lex3r1urc1(lx_11);
          var X60Qdesugar_5 = X60Qx_188;
          X60Qx_5 = (((mem.u8At((X60Qdesugar_4 + (X60Qdesugar_5 >>> 3))) & ((1 << ((X60Qdesugar_5 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
        } else {
          X60Qx_5 = false;
        }
        if (X60Qx_5) {
          var X60Qx_189 = cur_0_lex3r1urc1(lx_11);
          add_1_sysvq0asl(s_8, X60Qx_189);
          advance_0_lex3r1urc1(lx_11);
        } else {
          break;
        }
      }
    }
  }
  var X60Qlhs_8 = (result_18 + 4);
  nimStrDestroy(X60Qlhs_8);
  mem.copy(X60Qlhs_8, s_8, 8);
  nimStrWasMoved(s_8);
  nimStrDestroy(s_8);
  return result_18;
  nimStrDestroy(s_8);
  return result_18;
}

function lexIdent_0_lex3r1urc1(lx_12) {
  whileStmtLabel_0: {
    var result_19 = allocFixed(72);
    eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_19);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_19);
    var X60Qx_190 = allocFixed(72);
    mem.copy(X60Qx_190, startToken_0_lex3r1urc1(lx_12, 1), 72);
    mem.copy(result_19, X60Qx_190, 72);
    var s_9 = allocFixed(8);
    mem.setU32(s_9, 0);
    mem.setU32((s_9 + 4), 0);
    {
      while (true) {
        var X60Qx_191;
        if ((mem.i32((lx_12 + 12)) < mem.i32((lx_12 + 8)))) {
          var X60Qx_192 = cur_0_lex3r1urc1(lx_12);
          var X60Qx_193 = isIdentCont_0_lex3r1urc1(X60Qx_192);
          X60Qx_191 = X60Qx_193;
        } else {
          X60Qx_191 = false;
        }
        if (X60Qx_191) {
          var X60Qx_194 = cur_0_lex3r1urc1(lx_12);
          add_1_sysvq0asl(s_9, X60Qx_194);
          advance_0_lex3r1urc1(lx_12);
        } else {
          break;
        }
      }
    }
  }
  var X60Qlhs_9 = (result_19 + 4);
  nimStrDestroy(X60Qlhs_9);
  var X60Qx_195 = allocFixed(8);
  mem.copy(X60Qx_195, nimStrDup(s_9), 8);
  mem.copy(X60Qlhs_9, X60Qx_195, 8);
  var X60Qx_196 = isKeyword_0_tok9e79hf(s_9);
  if (X60Qx_196) {
    mem.setU8(result_19, 2);
  }
  nimStrDestroy(s_9);
  return result_19;
  nimStrDestroy(s_9);
  return result_19;
}

function lexBackquotedIdent_0_lex3r1urc1(lx_13) {
  whileStmtLabel_0: {
    var result_20 = allocFixed(72);
    eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_20);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_20);
    var X60Qx_197 = allocFixed(72);
    mem.copy(X60Qx_197, startToken_0_lex3r1urc1(lx_13, 1), 72);
    mem.copy(result_20, X60Qx_197, 72);
    mem.setU8((result_20 + 56), true);
    advance_0_lex3r1urc1(lx_13);
    var s_10 = allocFixed(8);
    mem.setU32(s_10, 0);
    mem.setU32((s_10 + 4), 0);
    var parts_0 = allocFixed(8);
    mem.copy(parts_0, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
    {
      while (true) {
        var X60Qx_198;
        var X60Qx_199;
        if ((mem.i32((lx_13 + 12)) < mem.i32((lx_13 + 8)))) {
          var X60Qx_200 = cur_0_lex3r1urc1(lx_13);
          X60Qx_199 = (!(X60Qx_200 === 96));
        } else {
          X60Qx_199 = false;
        }
        if (X60Qx_199) {
          var X60Qx_201 = cur_0_lex3r1urc1(lx_13);
          X60Qx_198 = (!(X60Qx_201 === 10));
        } else {
          X60Qx_198 = false;
        }
        if (X60Qx_198) {
          var c_11 = cur_0_lex3r1urc1(lx_13);
          var X60Qx_202;
          if ((c_11 === 32)) {
            X60Qx_202 = true;
          } else {
            X60Qx_202 = (c_11 === 9);
          }
          if (X60Qx_202) {
            advance_0_lex3r1urc1(lx_13);
          } else {
            var X60Qdesugar_6 = allocFixed(32);
            mem.copy(X60Qdesugar_6, QQuoteMergeChars_0_lex3r1urc1, 32);
            var X60Qdesugar_7 = c_11;
            if ((((mem.u8At((X60Qdesugar_6 + (X60Qdesugar_7 >>> 3))) & ((1 << ((X60Qdesugar_7 & 7) >>> 0)) >>> 0)) >>> 0) !== 0)) {
              whileStmtLabel_1: {
                var run_0 = allocFixed(8);
                mem.setU32(run_0, 0);
                mem.setU32((run_0 + 4), 0);
                {
                  while (true) {
                    var X60Qx_6;
                    if ((mem.i32((lx_13 + 12)) < mem.i32((lx_13 + 8)))) {
                      var X60Qdesugar_8 = allocFixed(32);
                      mem.copy(X60Qdesugar_8, QQuoteMergeChars_0_lex3r1urc1, 32);
                      var X60Qx_203 = cur_0_lex3r1urc1(lx_13);
                      var X60Qdesugar_9 = X60Qx_203;
                      X60Qx_6 = (((mem.u8At((X60Qdesugar_8 + (X60Qdesugar_9 >>> 3))) & ((1 << ((X60Qdesugar_9 & 7) >>> 0)) >>> 0)) >>> 0) !== 0);
                    } else {
                      X60Qx_6 = false;
                    }
                    if (X60Qx_6) {
                      var X60Qx_204 = cur_0_lex3r1urc1(lx_13);
                      add_1_sysvq0asl(run_0, X60Qx_204);
                      var X60Qx_205 = cur_0_lex3r1urc1(lx_13);
                      add_1_sysvq0asl(s_10, X60Qx_205);
                      advance_0_lex3r1urc1(lx_13);
                    } else {
                      break;
                    }
                  }
                }
              }
              var X60Qtmp_10 = allocFixed(8);
              mem.copy(X60Qtmp_10, run_0, 8);
              nimStrWasMoved(run_0);
              add_0_Ig6072n_cmdqs323n1(parts_0, X60Qtmp_10);
              nimStrDestroy(run_0);
            } else {
              var X60Qx_206;
              var X60Qx_207 = isIdentStart_0_lex3r1urc1(c_11);
              if (X60Qx_207) {
                X60Qx_206 = true;
              } else {
                var X60Qx_208 = isDigit_0_lex3r1urc1(c_11);
                X60Qx_206 = X60Qx_208;
              }
              if (X60Qx_206) {
                whileStmtLabel_2: {
                  var word_0 = allocFixed(8);
                  mem.setU32(word_0, 0);
                  mem.setU32((word_0 + 4), 0);
                  {
                    while (true) {
                      var X60Qx_209;
                      if ((mem.i32((lx_13 + 12)) < mem.i32((lx_13 + 8)))) {
                        var X60Qx_210 = cur_0_lex3r1urc1(lx_13);
                        var X60Qx_211 = isIdentCont_0_lex3r1urc1(X60Qx_210);
                        X60Qx_209 = X60Qx_211;
                      } else {
                        X60Qx_209 = false;
                      }
                      if (X60Qx_209) {
                        var X60Qx_212 = cur_0_lex3r1urc1(lx_13);
                        add_1_sysvq0asl(word_0, X60Qx_212);
                        var X60Qx_213 = cur_0_lex3r1urc1(lx_13);
                        add_1_sysvq0asl(s_10, X60Qx_213);
                        advance_0_lex3r1urc1(lx_13);
                      } else {
                        break;
                      }
                    }
                  }
                }
                var X60Qtmp_11 = allocFixed(8);
                mem.copy(X60Qtmp_11, word_0, 8);
                nimStrWasMoved(word_0);
                add_0_Ig6072n_cmdqs323n1(parts_0, X60Qtmp_11);
                nimStrDestroy(word_0);
              } else {
                var one_0 = allocFixed(8);
                mem.setU32(one_0, 0);
                mem.setU32((one_0 + 4), 0);
                add_1_sysvq0asl(one_0, c_11);
                add_1_sysvq0asl(s_10, c_11);
                advance_0_lex3r1urc1(lx_13);
                var X60Qtmp_12 = allocFixed(8);
                mem.copy(X60Qtmp_12, one_0, 8);
                nimStrWasMoved(one_0);
                add_0_Ig6072n_cmdqs323n1(parts_0, X60Qtmp_12);
                nimStrDestroy(one_0);
              }
            }
          }
        } else {
          break;
        }
      }
    }
  }
  var X60Qx_214 = cur_0_lex3r1urc1(lx_13);
  if ((X60Qx_214 === 96)) {
    advance_0_lex3r1urc1(lx_13);
  }
  var X60Qlhs_13 = (result_20 + 4);
  nimStrDestroy(X60Qlhs_13);
  mem.copy(X60Qlhs_13, s_10, 8);
  nimStrWasMoved(s_10);
  var X60Qlhs_14 = (result_20 + 60);
  eQdestroy_1_Ivioh0a_cmdqs323n1(X60Qlhs_14);
  mem.copy(X60Qlhs_14, parts_0, 8);
  eQwasMoved_1_I5vdnla_cmdqs323n1(parts_0);
  eQdestroy_1_Ivioh0a_cmdqs323n1(parts_0);
  nimStrDestroy(s_10);
  return result_20;
  eQdestroy_1_Ivioh0a_cmdqs323n1(parts_0);
  nimStrDestroy(s_10);
  return result_20;
}

function skipBlockComment_0_lex3r1urc1(lx_14) {
  whileStmtLabel_0: {
    advance_0_lex3r1urc1(lx_14);
    advance_0_lex3r1urc1(lx_14);
    var depth_0 = allocFixed(4);
    mem.setI32(depth_0, 1);
    {
      while (true) {
        var X60Qx_215;
        if ((mem.i32((lx_14 + 12)) < mem.i32((lx_14 + 8)))) {
          X60Qx_215 = (0 < mem.i32(depth_0));
        } else {
          X60Qx_215 = false;
        }
        if (X60Qx_215) {
          var X60Qx_216;
          var X60Qx_217 = cur_0_lex3r1urc1(lx_14);
          if ((X60Qx_217 === 35)) {
            var X60Qx_218 = peek_0_lex3r1urc1(lx_14, 1);
            X60Qx_216 = (X60Qx_218 === 91);
          } else {
            X60Qx_216 = false;
          }
          if (X60Qx_216) {
            advance_0_lex3r1urc1(lx_14);
            advance_0_lex3r1urc1(lx_14);
            inc_1_I6wjjge_cmdqs323n1(depth_0);
          } else {
            var X60Qx_219;
            var X60Qx_220 = cur_0_lex3r1urc1(lx_14);
            if ((X60Qx_220 === 93)) {
              var X60Qx_221 = peek_0_lex3r1urc1(lx_14, 1);
              X60Qx_219 = (X60Qx_221 === 35);
            } else {
              X60Qx_219 = false;
            }
            if (X60Qx_219) {
              advance_0_lex3r1urc1(lx_14);
              advance_0_lex3r1urc1(lx_14);
              dec_1_I0nzoz91_envto7w6l1(depth_0);
            } else {
              advance_0_lex3r1urc1(lx_14);
            }
          }
        } else {
          break;
        }
      }
    }
  }
}

function skipDocBlockComment_0_lex3r1urc1(lx_15) {
  whileStmtLabel_0: {
    advance_0_lex3r1urc1(lx_15);
    advance_0_lex3r1urc1(lx_15);
    advance_0_lex3r1urc1(lx_15);
    var depth_1 = allocFixed(4);
    mem.setI32(depth_1, 1);
    {
      while (true) {
        var X60Qx_222;
        if ((mem.i32((lx_15 + 12)) < mem.i32((lx_15 + 8)))) {
          X60Qx_222 = (0 < mem.i32(depth_1));
        } else {
          X60Qx_222 = false;
        }
        if (X60Qx_222) {
          var X60Qx_223;
          var X60Qx_224;
          var X60Qx_225 = cur_0_lex3r1urc1(lx_15);
          if ((X60Qx_225 === 35)) {
            var X60Qx_226 = peek_0_lex3r1urc1(lx_15, 1);
            X60Qx_224 = (X60Qx_226 === 35);
          } else {
            X60Qx_224 = false;
          }
          if (X60Qx_224) {
            var X60Qx_227 = peek_0_lex3r1urc1(lx_15, 2);
            X60Qx_223 = (X60Qx_227 === 91);
          } else {
            X60Qx_223 = false;
          }
          if (X60Qx_223) {
            advance_0_lex3r1urc1(lx_15);
            advance_0_lex3r1urc1(lx_15);
            advance_0_lex3r1urc1(lx_15);
            inc_1_I6wjjge_cmdqs323n1(depth_1);
          } else {
            var X60Qx_228;
            var X60Qx_229;
            var X60Qx_230 = cur_0_lex3r1urc1(lx_15);
            if ((X60Qx_230 === 93)) {
              var X60Qx_231 = peek_0_lex3r1urc1(lx_15, 1);
              X60Qx_229 = (X60Qx_231 === 35);
            } else {
              X60Qx_229 = false;
            }
            if (X60Qx_229) {
              var X60Qx_232 = peek_0_lex3r1urc1(lx_15, 2);
              X60Qx_228 = (X60Qx_232 === 35);
            } else {
              X60Qx_228 = false;
            }
            if (X60Qx_228) {
              advance_0_lex3r1urc1(lx_15);
              advance_0_lex3r1urc1(lx_15);
              advance_0_lex3r1urc1(lx_15);
              dec_1_I0nzoz91_envto7w6l1(depth_1);
            } else {
              advance_0_lex3r1urc1(lx_15);
            }
          }
        } else {
          break;
        }
      }
    }
  }
}

function tokenize_0_lex3r1urc1(src_1) {
  whileStmtLabel_0: {
    var result_21 = allocFixed(8);
    eQwasMoved_1_I4bu01z_lex3r1urc1(result_21);
    var lx_16 = allocFixed(28);
    mem.copy(lx_16, initLexer_0_lex3r1urc1(src_1), 28);
    eQdestroy_1_Ie8xo6a1_lex3r1urc1(result_21);
    var X60Qx_233 = allocFixed(8);
    mem.copy(X60Qx_233, newSeqUninit_0_I28kyaw1_lex3r1urc1(0), 8);
    mem.copy(result_21, X60Qx_233, 8);
    {
      while ((mem.i32((lx_16 + 12)) < mem.i32((lx_16 + 8)))) {
        var before_0 = len_3_Iefkljt1_lex3r1urc1(result_21);
        var c_12 = cur_0_lex3r1urc1(lx_16);
        var X60Qx_234;
        var X60Qx_235;
        if ((c_12 === 32)) {
          X60Qx_235 = true;
        } else {
          X60Qx_235 = (c_12 === 9);
        }
        if (X60Qx_235) {
          X60Qx_234 = true;
        } else {
          X60Qx_234 = (c_12 === 13);
        }
        if (X60Qx_234) {
          advance_0_lex3r1urc1(lx_16);
        } else {
          if ((c_12 === 10)) {
            advance_0_lex3r1urc1(lx_16);
          } else {
            if ((c_12 === 35)) {
              var X60Qx_236 = peek_0_lex3r1urc1(lx_16, 1);
              if ((X60Qx_236 === 91)) {
                skipBlockComment_0_lex3r1urc1(lx_16);
              } else {
                var X60Qx_237;
                var X60Qx_238 = peek_0_lex3r1urc1(lx_16, 1);
                if ((X60Qx_238 === 35)) {
                  var X60Qx_239 = peek_0_lex3r1urc1(lx_16, 2);
                  X60Qx_237 = (X60Qx_239 === 91);
                } else {
                  X60Qx_237 = false;
                }
                if (X60Qx_237) {
                  var standalone_0 = mem.u8At((lx_16 + 24));
                  var t_0 = allocFixed(72);
                  mem.copy(t_0, startToken_0_lex3r1urc1(lx_16, 20), 72);
                  skipDocBlockComment_0_lex3r1urc1(lx_16);
                  mem.setU8((lx_16 + 24), false);
                  if (standalone_0) {
                    var X60Qtmp_15 = allocFixed(72);
                    mem.copy(X60Qtmp_15, t_0, 72);
                    eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_0);
                    add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_15);
                  }
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_0);
                } else {
                  var X60Qx_240 = peek_0_lex3r1urc1(lx_16, 1);
                  if ((X60Qx_240 === 35)) {
                    whileStmtLabel_1: {
                      var standalone_1 = mem.u8At((lx_16 + 24));
                      var t_1 = allocFixed(72);
                      mem.copy(t_1, startToken_0_lex3r1urc1(lx_16, 20), 72);
                      {
                        while (true) {
                          whileStmtLabel_3: {
                            whileStmtLabel_2: {
                              {
                                while (true) {
                                  var X60Qx_241;
                                  if ((mem.i32((lx_16 + 12)) < mem.i32((lx_16 + 8)))) {
                                    var X60Qx_242 = cur_0_lex3r1urc1(lx_16);
                                    X60Qx_241 = (!(X60Qx_242 === 10));
                                  } else {
                                    X60Qx_241 = false;
                                  }
                                  if (X60Qx_241) {
                                    advance_0_lex3r1urc1(lx_16);
                                  } else {
                                    break;
                                  }
                                }
                              }
                            }
                            var X60Qx_243 = cur_0_lex3r1urc1(lx_16);
                            if ((!(X60Qx_243 === 10))) {
                              break whileStmtLabel_1;
                            }
                            var k_3 = allocFixed(4);
                            mem.setI32(k_3, 1);
                            {
                              while (true) {
                                var X60Qx_244;
                                var X60Qx_245 = peek_0_lex3r1urc1(lx_16, mem.i32(k_3));
                                if ((X60Qx_245 === 32)) {
                                  X60Qx_244 = true;
                                } else {
                                  var X60Qx_246 = peek_0_lex3r1urc1(lx_16, mem.i32(k_3));
                                  X60Qx_244 = (X60Qx_246 === 9);
                                }
                                if (X60Qx_244) {
                                  inc_1_I6wjjge_cmdqs323n1(k_3);
                                } else {
                                  break;
                                }
                              }
                            }
                          }
                          var X60Qx_247;
                          var X60Qx_248 = peek_0_lex3r1urc1(lx_16, mem.i32(k_3));
                          if ((X60Qx_248 === 35)) {
                            var X60Qx_249 = peek_0_lex3r1urc1(lx_16, ((mem.i32(k_3) + 1) | 0));
                            X60Qx_247 = (X60Qx_249 === 35);
                          } else {
                            X60Qx_247 = false;
                          }
                          if (X60Qx_247) {
                            whileStmtLabel_4: {
                              {
                                while ((0 < mem.i32(k_3))) {
                                  advance_0_lex3r1urc1(lx_16);
                                  dec_1_I0nzoz91_envto7w6l1(k_3);
                                }
                              }
                            }
                          } else {
                            break whileStmtLabel_1;
                          }
                        }
                      }
                    }
                    mem.setU8((lx_16 + 24), false);
                    if (standalone_1) {
                      var X60Qtmp_16 = allocFixed(72);
                      mem.copy(X60Qtmp_16, t_1, 72);
                      eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_1);
                      add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_16);
                    }
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_1);
                  } else {
                    whileStmtLabel_5: {
                      {
                        while (true) {
                          var X60Qx_250;
                          if ((mem.i32((lx_16 + 12)) < mem.i32((lx_16 + 8)))) {
                            var X60Qx_251 = cur_0_lex3r1urc1(lx_16);
                            X60Qx_250 = (!(X60Qx_251 === 10));
                          } else {
                            X60Qx_250 = false;
                          }
                          if (X60Qx_250) {
                            advance_0_lex3r1urc1(lx_16);
                          } else {
                            break;
                          }
                        }
                      }
                    }
                  }
                }
              }
            } else {
              if ((c_12 === 34)) {
                var t_2 = allocFixed(72);
                mem.copy(t_2, lexString_0_lex3r1urc1(lx_16), 72);
                mem.setU8((lx_16 + 24), false);
                var X60Qtmp_17 = allocFixed(72);
                mem.copy(X60Qtmp_17, t_2, 72);
                eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_2);
                add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_17);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_2);
              } else {
                var X60Qx_252;
                var X60Qx_253;
                if ((c_12 === 114)) {
                  X60Qx_253 = true;
                } else {
                  X60Qx_253 = (c_12 === 82);
                }
                if (X60Qx_253) {
                  var X60Qx_254 = peek_0_lex3r1urc1(lx_16, 1);
                  X60Qx_252 = (X60Qx_254 === 34);
                } else {
                  X60Qx_252 = false;
                }
                if (X60Qx_252) {
                  var t_3 = allocFixed(72);
                  mem.copy(t_3, lexRawOrTriple_0_lex3r1urc1(lx_16), 72);
                  mem.setU8((lx_16 + 24), false);
                  var X60Qtmp_18 = allocFixed(72);
                  mem.copy(X60Qtmp_18, t_3, 72);
                  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_3);
                  add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_18);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_3);
                } else {
                  if ((c_12 === 39)) {
                    var t_4 = allocFixed(72);
                    mem.copy(t_4, lexChar_0_lex3r1urc1(lx_16), 72);
                    mem.setU8((lx_16 + 24), false);
                    var X60Qtmp_19 = allocFixed(72);
                    mem.copy(X60Qtmp_19, t_4, 72);
                    eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_4);
                    add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_19);
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_4);
                  } else {
                    if ((c_12 === 96)) {
                      var t_5 = allocFixed(72);
                      mem.copy(t_5, lexBackquotedIdent_0_lex3r1urc1(lx_16), 72);
                      mem.setU8((lx_16 + 24), false);
                      var X60Qtmp_20 = allocFixed(72);
                      mem.copy(X60Qtmp_20, t_5, 72);
                      eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_5);
                      add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_20);
                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_5);
                    } else {
                      var X60Qx_255 = isDigit_0_lex3r1urc1(c_12);
                      if (X60Qx_255) {
                        var t_6 = allocFixed(72);
                        mem.copy(t_6, lexNumber_0_lex3r1urc1(lx_16), 72);
                        mem.setU8((lx_16 + 24), false);
                        var X60Qtmp_21 = allocFixed(72);
                        mem.copy(X60Qtmp_21, t_6, 72);
                        eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_6);
                        add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_21);
                        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_6);
                      } else {
                        var X60Qx_256 = isIdentStart_0_lex3r1urc1(c_12);
                        if (X60Qx_256) {
                          var t_7 = allocFixed(72);
                          mem.copy(t_7, lexIdent_0_lex3r1urc1(lx_16), 72);
                          mem.setU8((lx_16 + 24), false);
                          var X60Qtmp_22 = allocFixed(72);
                          mem.copy(X60Qtmp_22, t_7, 72);
                          eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_7);
                          add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_22);
                          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_7);
                        } else {
                          if ((c_12 === 40)) {
                            var t_8 = allocFixed(72);
                            mem.copy(t_8, startToken_0_lex3r1urc1(lx_16, 10), 72);
                            mem.setU8((lx_16 + 24), false);
                            advance_0_lex3r1urc1(lx_16);
                            var X60Qtmp_23 = allocFixed(72);
                            mem.copy(X60Qtmp_23, t_8, 72);
                            eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_8);
                            add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_23);
                            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_8);
                          } else {
                            if ((c_12 === 41)) {
                              var t_9 = allocFixed(72);
                              mem.copy(t_9, startToken_0_lex3r1urc1(lx_16, 11), 72);
                              mem.setU8((lx_16 + 24), false);
                              advance_0_lex3r1urc1(lx_16);
                              var X60Qtmp_24 = allocFixed(72);
                              mem.copy(X60Qtmp_24, t_9, 72);
                              eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_9);
                              add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_24);
                              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_9);
                            } else {
                              if ((c_12 === 91)) {
                                var t_10 = allocFixed(72);
                                mem.copy(t_10, startToken_0_lex3r1urc1(lx_16, 12), 72);
                                mem.setU8((lx_16 + 24), false);
                                advance_0_lex3r1urc1(lx_16);
                                var X60Qtmp_25 = allocFixed(72);
                                mem.copy(X60Qtmp_25, t_10, 72);
                                eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_10);
                                add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_25);
                                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_10);
                              } else {
                                if ((c_12 === 93)) {
                                  var t_11 = allocFixed(72);
                                  mem.copy(t_11, startToken_0_lex3r1urc1(lx_16, 13), 72);
                                  mem.setU8((lx_16 + 24), false);
                                  advance_0_lex3r1urc1(lx_16);
                                  var X60Qtmp_26 = allocFixed(72);
                                  mem.copy(X60Qtmp_26, t_11, 72);
                                  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_11);
                                  add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_26);
                                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_11);
                                } else {
                                  if ((c_12 === 123)) {
                                    var t_12 = allocFixed(72);
                                    mem.copy(t_12, startToken_0_lex3r1urc1(lx_16, 14), 72);
                                    mem.setU8((lx_16 + 24), false);
                                    advance_0_lex3r1urc1(lx_16);
                                    var X60Qtmp_27 = allocFixed(72);
                                    mem.copy(X60Qtmp_27, t_12, 72);
                                    eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_12);
                                    add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_27);
                                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_12);
                                  } else {
                                    if ((c_12 === 125)) {
                                      var t_13 = allocFixed(72);
                                      mem.copy(t_13, startToken_0_lex3r1urc1(lx_16, 15), 72);
                                      mem.setU8((lx_16 + 24), false);
                                      advance_0_lex3r1urc1(lx_16);
                                      var X60Qtmp_28 = allocFixed(72);
                                      mem.copy(X60Qtmp_28, t_13, 72);
                                      eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_13);
                                      add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_28);
                                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_13);
                                    } else {
                                      if ((c_12 === 44)) {
                                        var t_14 = allocFixed(72);
                                        mem.copy(t_14, startToken_0_lex3r1urc1(lx_16, 16), 72);
                                        mem.setU8((lx_16 + 24), false);
                                        advance_0_lex3r1urc1(lx_16);
                                        var X60Qtmp_29 = allocFixed(72);
                                        mem.copy(X60Qtmp_29, t_14, 72);
                                        eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
                                        add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_29);
                                        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
                                      } else {
                                        if ((c_12 === 59)) {
                                          var t_15 = allocFixed(72);
                                          mem.copy(t_15, startToken_0_lex3r1urc1(lx_16, 17), 72);
                                          mem.setU8((lx_16 + 24), false);
                                          advance_0_lex3r1urc1(lx_16);
                                          var X60Qtmp_30 = allocFixed(72);
                                          mem.copy(X60Qtmp_30, t_15, 72);
                                          eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_15);
                                          add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_30);
                                          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_15);
                                        } else {
                                          var X60Qx_7;
                                          if ((c_12 === 58)) {
                                            var X60Qdesugar_10 = allocFixed(32);
                                            mem.copy(X60Qdesugar_10, OperatorChars_0_lex3r1urc1, 32);
                                            var X60Qx_257 = peek_0_lex3r1urc1(lx_16, 1);
                                            var X60Qdesugar_11 = X60Qx_257;
                                            X60Qx_7 = (!(((mem.u8At((X60Qdesugar_10 + (X60Qdesugar_11 >>> 3))) & ((1 << ((X60Qdesugar_11 & 7) >>> 0)) >>> 0)) >>> 0) !== 0));
                                          } else {
                                            X60Qx_7 = false;
                                          }
                                          if (X60Qx_7) {
                                            var t_16 = allocFixed(72);
                                            mem.copy(t_16, startToken_0_lex3r1urc1(lx_16, 18), 72);
                                            mem.setU8((lx_16 + 24), false);
                                            advance_0_lex3r1urc1(lx_16);
                                            var X60Qtmp_31 = allocFixed(72);
                                            mem.copy(X60Qtmp_31, t_16, 72);
                                            eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_16);
                                            add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_31);
                                            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_16);
                                          } else {
                                            var X60Qx_8;
                                            var X60Qx_9;
                                            if ((c_12 === 46)) {
                                              var X60Qdesugar_12 = allocFixed(32);
                                              mem.copy(X60Qdesugar_12, OperatorChars_0_lex3r1urc1, 32);
                                              var X60Qx_258 = peek_0_lex3r1urc1(lx_16, 1);
                                              var X60Qdesugar_13 = X60Qx_258;
                                              X60Qx_9 = (!(((mem.u8At((X60Qdesugar_12 + (X60Qdesugar_13 >>> 3))) & ((1 << ((X60Qdesugar_13 & 7) >>> 0)) >>> 0)) >>> 0) !== 0));
                                            } else {
                                              X60Qx_9 = false;
                                            }
                                            if (X60Qx_9) {
                                              var X60Qx_259 = peek_0_lex3r1urc1(lx_16, 1);
                                              var X60Qx_260 = isDigit_0_lex3r1urc1(X60Qx_259);
                                              X60Qx_8 = (!X60Qx_260);
                                            } else {
                                              X60Qx_8 = false;
                                            }
                                            if (X60Qx_8) {
                                              var t_17 = allocFixed(72);
                                              mem.copy(t_17, startToken_0_lex3r1urc1(lx_16, 19), 72);
                                              mem.setU8((lx_16 + 24), false);
                                              advance_0_lex3r1urc1(lx_16);
                                              var X60Qtmp_32 = allocFixed(72);
                                              mem.copy(X60Qtmp_32, t_17, 72);
                                              eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_17);
                                              add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_32);
                                              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_17);
                                            } else {
                                              var X60Qx_10;
                                              var X60Qx_261;
                                              if ((c_12 === 42)) {
                                                var X60Qx_262 = peek_0_lex3r1urc1(lx_16, 1);
                                                X60Qx_261 = (X60Qx_262 === 58);
                                              } else {
                                                X60Qx_261 = false;
                                              }
                                              if (X60Qx_261) {
                                                var X60Qdesugar_14 = allocFixed(32);
                                                mem.copy(X60Qdesugar_14, OperatorChars_0_lex3r1urc1, 32);
                                                var X60Qx_263 = peek_0_lex3r1urc1(lx_16, 2);
                                                var X60Qdesugar_15 = X60Qx_263;
                                                X60Qx_10 = (!(((mem.u8At((X60Qdesugar_14 + (X60Qdesugar_15 >>> 3))) & ((1 << ((X60Qdesugar_15 & 7) >>> 0)) >>> 0)) >>> 0) !== 0));
                                              } else {
                                                X60Qx_10 = false;
                                              }
                                              if (X60Qx_10) {
                                                var t_18 = allocFixed(72);
                                                mem.copy(t_18, startToken_0_lex3r1urc1(lx_16, 9), 72);
                                                var X60Qlhs_33 = (t_18 + 4);
                                                nimStrDestroy(X60Qlhs_33);
                                                mem.copy(X60Qlhs_33, (() => {
                                                  var _o = allocFixed(8);
                                                  mem.setU32(_o, 10753);
                                                  mem.setU32((_o + 4), 0);
                                                  return _o;
                                                })(), 8);
                                                advance_0_lex3r1urc1(lx_16);
                                                mem.setU8((lx_16 + 24), false);
                                                var X60Qtmp_34 = allocFixed(72);
                                                mem.copy(X60Qtmp_34, t_18, 72);
                                                eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_18);
                                                add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_34);
                                                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_18);
                                              } else {
                                                var X60Qdesugar_16 = allocFixed(32);
                                                mem.copy(X60Qdesugar_16, OperatorChars_0_lex3r1urc1, 32);
                                                var X60Qdesugar_17 = c_12;
                                                if ((((mem.u8At((X60Qdesugar_16 + (X60Qdesugar_17 >>> 3))) & ((1 << ((X60Qdesugar_17 & 7) >>> 0)) >>> 0)) >>> 0) !== 0)) {
                                                  var t_19 = allocFixed(72);
                                                  mem.copy(t_19, lexOperator_0_lex3r1urc1(lx_16), 72);
                                                  mem.setU8((lx_16 + 24), false);
                                                  var X60Qtmp_35 = allocFixed(72);
                                                  mem.copy(X60Qtmp_35, t_19, 72);
                                                  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(t_19);
                                                  add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_35);
                                                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_19);
                                                } else {
                                                  advance_0_lex3r1urc1(lx_16);
                                                }
                                              }
                                            }
                                          }
                                        }
                                      }
                                    }
                                  }
                                }
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        if ((before_0 < mem.i32(result_21))) {
          var X60Qx_264 = len_3_Iefkljt1_lex3r1urc1(result_21);
          var X60Qx_265 = getQ_7_Ijq9cyk1_lex3r1urc1(result_21, ((X60Qx_264 - 1) | 0));
          mem.setI32((X60Qx_265 + 48), mem.i32((lx_16 + 20)));
        }
      }
    }
  }
  var eof_0 = allocFixed(72);
  mem.copy(eof_0, initToken_0_tok9e79hf(0, mem.i32((lx_16 + 16)), mem.i32((lx_16 + 20))), 72);
  mem.setI32((eof_0 + 52), 0);
  var X60Qtmp_36 = allocFixed(72);
  mem.copy(X60Qtmp_36, eof_0, 72);
  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(eof_0);
  add_0_Icvfjtn_lex3r1urc1(result_21, X60Qtmp_36);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(eof_0);
  eQdestroyQ_SX4cexer0lex3r1urc1_0_lex3r1urc1(lx_16);
  return result_21;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(eof_0);
  eQdestroyQ_SX4cexer0lex3r1urc1_0_lex3r1urc1(lx_16);
  return result_21;
}

function newSeqUninit_0_I28kyaw1_lex3r1urc1(size_4) {
  let result_23 = allocFixed(8);
  if ((size_4 === 0)) {
    mem.copy(result_23, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_4);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_1 = memSizeInBytes_0_Imlcc9c1_lex3r1urc1(size_4);
    let X60Qx_270 = alloc_1_sysvq0asl(memSize_1);
    mem.copy(result_23, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_4);
      mem.setU32((_o + 4), X60Qx_270);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_23 + 4)) === 0))) {
      let X60Qx_271 = allocFixed(8);
      mem.setU32(X60Qx_271, 1634036990);
      mem.setU32((X60Qx_271 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_23, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_1);
    }
  }
  return result_23;
}

function len_3_Iefkljt1_lex3r1urc1(s_17) {
  let result_24;
  result_24 = mem.i32(s_17);
  return result_24;
}

function add_0_Icvfjtn_lex3r1urc1(s_18, elem_3) {
  let L_1 = mem.i32(s_18);
  let X60Qx_272 = capInBytes_0_Iztvafh1_lex3r1urc1(s_18);
  if ((X60Qx_272 < ((Math.imul(L_1, 72) + 72) | 0))) {
    let X60Qx_273 = resize_0_Ijirql71_lex3r1urc1(s_18, 1);
    if ((!X60Qx_273)) {
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(elem_3);
      return;
    }
  }
  inc_1_I6wjjge_cmdqs323n1(s_18);
  mem.copy((mem.u32((s_18 + 4)) + (L_1 * 72)), elem_3, 72);
}

function getQ_7_Ijq9cyk1_lex3r1urc1(s_20, i_3) {
  let X60Qx_274;
  if ((i_3 < mem.i32(s_20))) {
    X60Qx_274 = (0 <= i_3);
  } else {
    X60Qx_274 = false;
  }
  if ((!X60Qx_274)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_25;
  result_25 = (mem.u32((s_20 + 4)) + (i_3 * 72));
  return result_25;
}

function memSizeInBytes_0_Imlcc9c1_lex3r1urc1(size_7) {
  let result_31;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_7, 72);
  result_31 = X60QconstRefTemp_0;
  if (false) {
    result_31 = 2147483647;
  }
  return result_31;
}

function capInBytes_0_Iztvafh1_lex3r1urc1(s_22) {
  let result_32;
  let X60Qx_12;
  if ((!(mem.u32((s_22 + 4)) === 0))) {
    let X60Qx_279 = allocatedSize_0_sysvq0asl(mem.u32((s_22 + 4)));
    X60Qx_12 = X60Qx_279;
  } else {
    X60Qx_12 = 0;
  }
  result_32 = X60Qx_12;
  return result_32;
}

function resize_0_Ijirql71_lex3r1urc1(dest_3, addedElements_3) {
  let result_33;
  let X60Qx_280 = capInBytes_0_Iztvafh1_lex3r1urc1(dest_3);
  let oldCap_1 = Math.trunc((X60Qx_280 / 72));
  let newCap_1 = recalcCap_0_sysvq0asl(oldCap_1, addedElements_3);
  let memSize_3 = memSizeInBytes_0_Imlcc9c1_lex3r1urc1(newCap_1);
  let X60Qx_281 = realloc_1_sysvq0asl(mem.u32((dest_3 + 4)), memSize_3);
  mem.setU32((dest_3 + 4), X60Qx_281);
  if ((mem.u32((dest_3 + 4)) === 0)) {
    mem.setI32(dest_3, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_3);
    result_33 = false;
  } else {
    result_33 = true;
  }
  return result_33;
}

function eQdestroy_1_Ie8xo6a1_lex3r1urc1(s_27) {
  if ((!(mem.u32((s_27 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_4 = allocFixed(4);
      mem.setI32(i_4, 0);
      {
        while ((mem.i32(i_4) < mem.i32(s_27))) {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf((mem.u32((s_27 + 4)) + (mem.i32(i_4) * 72)));
          inc_1_I6wjjge_cmdqs323n1(i_4);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_27 + 4)));
  }
}

function eQwasMoved_1_I4bu01z_lex3r1urc1(s_28) {
  mem.setI32(s_28, 0);
  mem.setU32((s_28 + 4), 0);
}

function eQdup_1_Ikdu5b_lex3r1urc1(a_6) {
  whileStmtLabel_0: {
    var result_34 = allocFixed(8);
    var X60Qx_282 = allocFixed(8);
    mem.copy(X60Qx_282, newSeqUninit_0_I28kyaw1_lex3r1urc1(mem.i32(a_6)), 8);
    mem.copy(result_34, X60Qx_282, 8);
    var i_5 = allocFixed(4);
    mem.setI32(i_5, 0);
    {
      while ((mem.i32(i_5) < mem.i32(a_6))) {
        var X60Qx_283 = allocFixed(72);
        mem.copy(X60Qx_283, eQdupQ_SX54oken0tok9e79hf_0_tok9e79hf((mem.u32((a_6 + 4)) + (mem.i32(i_5) * 72))), 72);
        mem.copy((mem.u32((result_34 + 4)) + (mem.i32(i_5) * 72)), X60Qx_283, 72);
        inc_1_I6wjjge_cmdqs323n1(i_5);
      }
    }
  }
  return result_34;
}

function eQdestroyQ_SX4cexer0lex3r1urc1_0_lex3r1urc1(dest_0) {
  nimStrDestroy(dest_0);
}

function eQwasmovedQ_SX4cexer0lex3r1urc1_0_lex3r1urc1(dest_0) {
  nimStrWasMoved(dest_0);
}

function eQdupQ_SX4cexer0lex3r1urc1_0_lex3r1urc1(src_0) {
  let dest_0 = allocFixed(28);
  let X60Qx_294 = allocFixed(8);
  mem.copy(X60Qx_294, nimStrDup(src_0), 8);
  mem.copy(dest_0, X60Qx_294, 8);
  mem.setI32((dest_0 + 8), mem.i32((src_0 + 8)));
  mem.setI32((dest_0 + 12), mem.i32((src_0 + 12)));
  mem.setI32((dest_0 + 16), mem.i32((src_0 + 16)));
  mem.setI32((dest_0 + 20), mem.i32((src_0 + 20)));
  mem.setU8((dest_0 + 24), mem.u8At((src_0 + 24)));
  return dest_0;
}

let X60QiniGuard_0_lex3r1urc1 = allocFixed(1);

function X60Qini_0_lex3r1urc1() {
  if (mem.u8At(X60QiniGuard_0_lex3r1urc1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_lex3r1urc1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_tok9e79hf();
  X60Qini_0_party5a2l1();
}
// generated by lengc (js backend) from jsfc0lwq21.c.nif

function eQdestroy_0_jsfc0lwq21(x_2) {
  _jsRelease(mem.i32(x_2));
}

function toJs_3_jsfc0lwq21(s_0) {
  let result_10 = allocFixed(4);
  let t_0 = allocFixed(8);
  mem.copy(t_0, nimStrDup(s_0), 8);
  eQdestroy_0_jsfc0lwq21(result_10);
  let X60Qx_10 = toCString_0_sysvq0asl(t_0);
  let X60Qx_11 = len_4_sysvq0asl(t_0);
  let X60Qx_12 = _strToJs(X60Qx_10, X60Qx_11);
  mem.copy(result_10, (() => {
    let _o = allocFixed(4);
    mem.setI32(_o, X60Qx_12);
    return _o;
  })(), 4);
  nimStrDestroy(t_0);
  return result_10;
  nimStrDestroy(t_0);
  return result_10;
}

function toStr_0_jsfc0lwq21(v_7) {
  let result_11 = allocFixed(8);
  nimStrWasMoved(result_11);
  let n_1 = _jsStrLen(mem.i32(v_7));
  if ((n_1 <= 0)) {
    return (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })();
  }
  nimStrDestroy(result_11);
  let X60Qx_13 = allocFixed(8);
  mem.copy(X60Qx_13, newString_0_sysvq0asl(n_1), 8);
  mem.copy(result_11, X60Qx_13, 8);
  let X60Qx_14 = toCString_0_sysvq0asl(result_11);
  _jsStrInto(mem.i32(v_7), X60Qx_14);
  return result_11;
}

function global_0_jsfc0lwq21(name_8) {
  let result_19 = allocFixed(4);
  let n_2 = allocFixed(4);
  mem.copy(n_2, toJs_3_jsfc0lwq21(name_8), 4);
  eQdestroy_0_jsfc0lwq21(result_19);
  let X60Qx_22 = _jsGlobalH(mem.i32(n_2));
  mem.copy(result_19, (() => {
    let _o = allocFixed(4);
    mem.setI32(_o, X60Qx_22);
    return _o;
  })(), 4);
  eQdestroy_0_jsfc0lwq21(n_2);
  return result_19;
  eQdestroy_0_jsfc0lwq21(n_2);
  return result_19;
}

function set_0_jsfc0lwq21(obj_9, name_10, val_3) {
  let n_4 = allocFixed(4);
  mem.copy(n_4, toJs_3_jsfc0lwq21(name_10), 4);
  _jsSetProp(mem.i32(obj_9), mem.i32(n_4), mem.i32(val_3));
  eQdestroy_0_jsfc0lwq21(n_4);
}

let X60QiniGuard_0_jsfc0lwq21 = allocFixed(1);

function X60Qini_0_jsfc0lwq21() {
  if (mem.u8At(X60QiniGuard_0_jsfc0lwq21)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_jsfc0lwq21, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from dir38pj6l.c.nif

let X60QiniGuard_0_dir38pj6l = allocFixed(1);

function X60Qini_0_dir38pj6l() {
  if (mem.u8At(X60QiniGuard_0_dir38pj6l)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_dir38pj6l, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_osezuyu63();
  X60Qini_0_pat4k2dls();
  X60Qini_0_ossk30t39();
  X60Qini_0_osc4bsu0d1();
  X60Qini_0_pososrh1q1();
  X60Qini_0_err0o7h081();
}
// generated by lengc (js backend) from parq39nt2.c.nif

function initParser_0_parq39nt2(toks_0, file_0, curly_0) {
  let result_0 = allocFixed(20);
  eQwasmovedQ_SX50arser0parq39nt2_0_parq39nt2(result_0);
  eQdestroyQ_SX50arser0parq39nt2_0_parq39nt2(result_0);
  let X60Qx_160 = allocFixed(8);
  mem.copy(X60Qx_160, eQdup_1_Ikdu5b_lex3r1urc1(toks_0), 8);
  let X60Qx_161 = allocFixed(8);
  mem.copy(X60Qx_161, nimStrDup(file_0), 8);
  mem.copy(result_0, (() => {
    let _o = allocFixed(20);
    mem.copy(_o, X60Qx_160, 8);
    mem.copy((_o + 8), X60Qx_161, 8);
    mem.setU8((_o + 16), curly_0);
    return _o;
  })(), 20);
  return result_0;
}

function tok_0_parq39nt2(ps_0, i_0) {
  let result_1 = allocFixed(72);
  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_1);
  let X60Qx_0 = allocFixed(72);
  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_0);
  let X60Qx_162;
  if ((0 <= i_0)) {
    let X60Qx_163 = len_3_Iefkljt1_lex3r1urc1(ps_0);
    X60Qx_162 = (i_0 < X60Qx_163);
  } else {
    X60Qx_162 = false;
  }
  if (X60Qx_162) {
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_0);
    let X60Qx_164 = getQ_7_Ijq9cyk1_lex3r1urc1(ps_0, i_0);
    let X60QconstRefTemp_0 = allocFixed(72);
    mem.copy(X60QconstRefTemp_0, X60Qx_164, 72);
    let X60Qx_165 = allocFixed(72);
    mem.copy(X60Qx_165, eQdupQ_SX54oken0tok9e79hf_0_tok9e79hf(X60QconstRefTemp_0), 72);
    mem.copy(X60Qx_0, X60Qx_165, 72);
  } else {
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_0);
    let X60Qx_166 = len_3_Iefkljt1_lex3r1urc1(ps_0);
    let X60Qx_167 = getQ_7_Ijq9cyk1_lex3r1urc1(ps_0, ((X60Qx_166 - 1) | 0));
    let X60QconstRefTemp_1 = allocFixed(72);
    mem.copy(X60QconstRefTemp_1, X60Qx_167, 72);
    let X60Qx_168 = allocFixed(72);
    mem.copy(X60Qx_168, eQdupQ_SX54oken0tok9e79hf_0_tok9e79hf(X60QconstRefTemp_1), 72);
    mem.copy(X60Qx_0, X60Qx_168, 72);
  }
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_1);
  mem.copy(result_1, X60Qx_0, 72);
  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_0);
  return result_1;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_0);
  return result_1;
}

function isOpenBracket_0_parq39nt2(k_0) {
  let result_2;
  let X60Qx_169;
  let X60Qx_170;
  if ((k_0 === 10)) {
    X60Qx_170 = true;
  } else {
    X60Qx_170 = (k_0 === 12);
  }
  if (X60Qx_170) {
    X60Qx_169 = true;
  } else {
    X60Qx_169 = (k_0 === 14);
  }
  result_2 = X60Qx_169;
  return result_2;
}

function isCloseBracket_0_parq39nt2(k_1) {
  let result_3;
  let X60Qx_171;
  let X60Qx_172;
  if ((k_1 === 11)) {
    X60Qx_172 = true;
  } else {
    X60Qx_172 = (k_1 === 13);
  }
  if (X60Qx_172) {
    X60Qx_171 = true;
  } else {
    X60Qx_171 = (k_1 === 15);
  }
  result_3 = X60Qx_171;
  return result_3;
}

function emitInfo_0_parq39nt2(ps_1, b_0, nl_0, nc_0, pl_0, pc_0, root_0) {
  if (root_0) {
    attachLineInfo_1_nifjp9lau1(b_0, nc_0, nl_0, (ps_1 + 8));
  } else {
    attachLineInfo_1_nifjp9lau1(b_0, ((nc_0 - pc_0) | 0), ((nl_0 - pl_0) | 0), (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
  }
}

function opIsInfix_0_parq39nt2(ps_2, i_1, lo_0) {
  let result_4;
  if ((i_1 <= lo_0)) {
    return false;
  }
  let t_4 = allocFixed(72);
  mem.copy(t_4, tok_0_parq39nt2(ps_2, i_1), 72);
  let prev_1 = allocFixed(72);
  mem.copy(prev_1, tok_0_parq39nt2(ps_2, ((i_1 - 1) | 0)), 72);
  let nxt_0 = allocFixed(72);
  mem.copy(nxt_0, tok_0_parq39nt2(ps_2, ((i_1 + 1) | 0)), 72);
  let X60Qx_173;
  if ((!(mem.i32((t_4 + 40)) === mem.i32((prev_1 + 40))))) {
    X60Qx_173 = true;
  } else {
    X60Qx_173 = (mem.i32((prev_1 + 48)) < mem.i32((t_4 + 44)));
  }
  let leadSpace_0 = X60Qx_173;
  let X60Qx_174;
  if ((!(mem.i32((nxt_0 + 40)) === mem.i32((t_4 + 40))))) {
    X60Qx_174 = true;
  } else {
    X60Qx_174 = (mem.i32((t_4 + 48)) < mem.i32((nxt_0 + 44)));
  }
  let trailSpace_0 = X60Qx_174;
  let X60Qx_175;
  if (leadSpace_0) {
    X60Qx_175 = (!trailSpace_0);
  } else {
    X60Qx_175 = false;
  }
  if (X60Qx_175) {
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nxt_0);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(prev_1);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_4);
    return false;
  }
  result_4 = true;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nxt_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(prev_1);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_4);
  return result_4;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nxt_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(prev_1);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_4);
  return result_4;
}

function startsArg_0_parq39nt2(ps_3, i_2, hi_0) {
  let result_5;
  let t_5 = allocFixed(72);
  mem.copy(t_5, tok_0_parq39nt2(ps_3, i_2), 72);
  if ((mem.u8At(t_5) === 9)) {
    if ((hi_0 <= ((i_2 + 1) | 0))) {
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_5);
      return false;
    }
    let nxt_1 = allocFixed(72);
    mem.copy(nxt_1, tok_0_parq39nt2(ps_3, ((i_2 + 1) | 0)), 72);
    let X60Qx_176;
    if ((mem.i32((nxt_1 + 40)) === mem.i32((t_5 + 40)))) {
      X60Qx_176 = (mem.i32((nxt_1 + 44)) === mem.i32((t_5 + 48)));
    } else {
      X60Qx_176 = false;
    }
    result_5 = X60Qx_176;
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nxt_1);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_5);
    return result_5;
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nxt_1);
  }
  let X60Qx_177;
  let X60Qx_178 = startsExpr_0_parq39nt2(t_5);
  if (X60Qx_178) {
    let X60Qx_179 = isBinaryOp_0_parq39nt2(t_5);
    X60Qx_177 = (!X60Qx_179);
  } else {
    X60Qx_177 = false;
  }
  result_5 = X60Qx_177;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_5);
  return result_5;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_5);
  return result_5;
}

function cmdCalleeEnd_0_parq39nt2(ps_4, lo_1, hi_1) {
  whileStmtLabel_0: {
    var result_6;
    var i_5 = allocFixed(4);
    mem.setI32(i_5, lo_1);
    var endCol_0;
    var X60Qtmp_0 = allocFixed(72);
    mem.copy(X60Qtmp_0, tok_0_parq39nt2(ps_4, mem.i32(i_5)), 72);
    var X60Qx_180 = isOpenBracket_0_parq39nt2(mem.u8At(X60Qtmp_0));
    if (X60Qx_180) {
      var c_0 = matchClose_0_parq39nt2(ps_4, mem.i32(i_5));
      var X60Qtmp_1 = allocFixed(72);
      mem.copy(X60Qtmp_1, tok_0_parq39nt2(ps_4, c_0), 72);
      endCol_0 = mem.i32((X60Qtmp_1 + 48));
      mem.setI32(i_5, ((c_0 + 1) | 0));
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_1);
    } else {
      var X60Qtmp_2 = allocFixed(72);
      mem.copy(X60Qtmp_2, tok_0_parq39nt2(ps_4, mem.i32(i_5)), 72);
      endCol_0 = mem.i32((X60Qtmp_2 + 48));
      inc_1_I6wjjge_cmdqs323n1(i_5);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_2);
    }
    {
      while ((mem.i32(i_5) < hi_1)) {
        var t_6 = allocFixed(72);
        mem.copy(t_6, tok_0_parq39nt2(ps_4, mem.i32(i_5)), 72);
        var X60Qx_181;
        if ((mem.u8At(t_6) === 19)) {
          X60Qx_181 = (((mem.i32(i_5) + 1) | 0) < hi_1);
        } else {
          X60Qx_181 = false;
        }
        if (X60Qx_181) {
          var nm_0 = allocFixed(72);
          mem.copy(nm_0, tok_0_parq39nt2(ps_4, ((mem.i32(i_5) + 1) | 0)), 72);
          endCol_0 = mem.i32((nm_0 + 48));
          plusQeQ_0_Iz7fdp7_mat7cnfv21(i_5, 2);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nm_0);
        } else {
          var X60Qx_50;
          var X60Qx_51;
          var X60Qx_182 = isOpenBracket_0_parq39nt2(mem.u8At(t_6));
          if (X60Qx_182) {
            var X60Qtmp_3 = allocFixed(72);
            mem.copy(X60Qtmp_3, tok_0_parq39nt2(ps_4, ((mem.i32(i_5) - 1) | 0)), 72);
            X60Qx_51 = (mem.i32((t_6 + 40)) === mem.i32((X60Qtmp_3 + 40)));
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_3);
          } else {
            X60Qx_51 = false;
          }
          if (X60Qx_51) {
            X60Qx_50 = (mem.i32((t_6 + 44)) === endCol_0);
          } else {
            X60Qx_50 = false;
          }
          if (X60Qx_50) {
            var c_1 = matchClose_0_parq39nt2(ps_4, mem.i32(i_5));
            var X60Qtmp_4 = allocFixed(72);
            mem.copy(X60Qtmp_4, tok_0_parq39nt2(ps_4, c_1), 72);
            endCol_0 = mem.i32((X60Qtmp_4 + 48));
            mem.setI32(i_5, ((c_1 + 1) | 0));
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_4);
          } else {
            var X60Qx_52;
            var X60Qx_53;
            var X60Qx_183;
            var X60Qx_184;
            if ((mem.u8At(t_6) === 5)) {
              X60Qx_184 = true;
            } else {
              X60Qx_184 = (mem.u8At(t_6) === 6);
            }
            if (X60Qx_184) {
              X60Qx_183 = true;
            } else {
              X60Qx_183 = (mem.u8At(t_6) === 7);
            }
            if (X60Qx_183) {
              var X60Qtmp_5 = allocFixed(72);
              mem.copy(X60Qtmp_5, tok_0_parq39nt2(ps_4, ((mem.i32(i_5) - 1) | 0)), 72);
              X60Qx_53 = (mem.i32((t_6 + 40)) === mem.i32((X60Qtmp_5 + 40)));
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_5);
            } else {
              X60Qx_53 = false;
            }
            if (X60Qx_53) {
              X60Qx_52 = (mem.i32((t_6 + 44)) === endCol_0);
            } else {
              X60Qx_52 = false;
            }
            if (X60Qx_52) {
              endCol_0 = mem.i32((t_6 + 44));
              inc_1_I6wjjge_cmdqs323n1(i_5);
            } else {
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_6);
              break whileStmtLabel_0;
            }
          }
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_6);
      }
    }
  }
  result_6 = mem.i32(i_5);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_0);
  return result_6;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_0);
  return result_6;
}

function emitName_0_parq39nt2(ps_5, b_1, t_0, pl_1, pc_1) {
  if (mem.u8At((t_0 + 56))) {
    forStmtLabel_0: {
      addTree_0_nifjp9lau1(b_1, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1869967870);
        mem.setU32((_o + 4), strlit_0_I1290833423478922541_parq39nt2);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_5, b_1, mem.i32((t_0 + 40)), mem.i32((t_0 + 44)), pl_1, pc_1, false);
      {
        whileStmtLabel_1: {
          var X60Qlf_0 = allocFixed(8);
          mem.copy(X60Qlf_0, toOpenArray_1_I6b60gk1_parq39nt2((t_0 + 60)), 8);
          var X60Qlf_1 = allocFixed(4);
          mem.setI32(X60Qlf_1, 0);
          {
            while (true) {
              var X60Qx_185 = len_6_Igv2wyu1_osalirkw71(X60Qlf_0);
              if ((mem.i32(X60Qlf_1) < X60Qx_185)) {
                {
                  var X60Qii_2 = allocFixed(4);
                  mem.setU32(X60Qii_2, getQ_10_Ik9hgkq1_osalirkw71(X60Qlf_0, mem.i32(X60Qlf_1)));
                  addIdent_0_nifjp9lau1(b_1, mem.u32(X60Qii_2));
                }
                inc_1_I6wjjge_cmdqs323n1(X60Qlf_1);
              } else {
                break;
              }
            }
          }
        }
      }
    }
    endTree_0_nifjp9lau1(b_1);
  } else {
    addIdent_0_nifjp9lau1(b_1, (t_0 + 4));
    emitInfo_0_parq39nt2(ps_5, b_1, mem.i32((t_0 + 40)), mem.i32((t_0 + 44)), pl_1, pc_1, false);
  }
}

function isBinaryOp_0_parq39nt2(t_1) {
  var result_7;
  if ((mem.u8At(t_1) === 2)) {
    forStmtLabel_0: {
      {
        whileStmtLabel_1: {
          var X60Qlf_2 = allocFixed(8);
          mem.copy(X60Qlf_2, toOpenArray_0_Ishwcxp1_parq39nt2(BinaryKeywords_0_parq39nt2), 8);
          var X60Qlf_3 = allocFixed(4);
          mem.setI32(X60Qlf_3, 0);
          {
            while (true) {
              var X60Qx_186 = len_6_Igv2wyu1_osalirkw71(X60Qlf_2);
              if ((mem.i32(X60Qlf_3) < X60Qx_186)) {
                {
                  var X60Qii_2 = allocFixed(4);
                  mem.setU32(X60Qii_2, getQ_10_Ik9hgkq1_osalirkw71(X60Qlf_2, mem.i32(X60Qlf_3)));
                  var X60Qx_187 = eqQ_20_sysvq0asl(mem.u32(X60Qii_2), (t_1 + 4));
                  if (X60Qx_187) {
                    return true;
                  }
                }
                inc_1_I6wjjge_cmdqs323n1(X60Qlf_3);
              } else {
                break;
              }
            }
          }
        }
      }
    }
    return false;
  } else {
    if ((mem.u8At(t_1) === 9)) {
      var X60Qx_188;
      var X60Qx_189 = eqQ_20_sysvq0asl((t_1 + 4), (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 15617);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      if ((!X60Qx_189)) {
        var X60Qx_190 = eqQ_20_sysvq0asl((t_1 + 4), (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 11777);
          mem.setU32((_o + 4), 0);
          return _o;
        })());
        X60Qx_188 = (!X60Qx_190);
      } else {
        X60Qx_188 = false;
      }
      result_7 = X60Qx_188;
      return result_7;
    } else {
      return false;
    }
  }
  return result_7;
}

function precedenceOf_0_parq39nt2(t_2) {
  var result_8;
  if ((mem.u8At(t_2) === 2)) {
    X60Qsc_7: {
      X60Qsc_8: {
        X60Qsc_3: {
          X60Qsc_2: {
            X60Qsc_1: {
              var X60Qtc_0 = allocFixed(8);
              mem.copy(X60Qtc_0, (t_2 + 4), 8);
              var X60Qtc_4 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 109);
              if (X60Qtc_4) {
                var X60Qtc_5 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 0, 100);
                if (X60Qtc_5) {
                  if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1986618371);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_1;
                  } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1684955395);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_2;
                  }
                } else {
                  if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1685024003);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_1;
                  }
                }
              } else {
                var X60Qtc_6 = nimStrAtLe_0_sysvq0asl(X60Qtc_0, 1, 104);
                if (X60Qtc_6) {
                  if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1818784515);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_1;
                  } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1919447811);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_1;
                  }
                } else {
                  if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 7499522);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_3;
                  } else if (equalStrings_0_sysvq0asl(X60Qtc_0, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1919907843);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })())) {
                    break X60Qsc_3;
                  }
                }
              }
              break X60Qsc_8;
            }
            return 9;
            break X60Qsc_7;
          }
          return 4;
          break X60Qsc_7;
        }
        return 3;
        break X60Qsc_7;
      }
      return 5;
    }
  }
  var X60Qx_191 = eqQ_20_sysvq0asl((t_2 + 4), (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 3026434);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  if (X60Qx_191) {
    return 6;
  }
  var X60Qx_192 = len_4_sysvq0asl((t_2 + 4));
  if ((X60Qx_192 === 0)) {
    return 2;
  }
  var X60Qx_193;
  var X60Qx_194;
  var X60Qx_195 = len_4_sysvq0asl((t_2 + 4));
  if ((1 < X60Qx_195)) {
    var X60Qx_196 = len_4_sysvq0asl((t_2 + 4));
    var X60Qx_197 = getQ_9_sysvq0asl((t_2 + 4), ((X60Qx_196 - 1) | 0));
    X60Qx_194 = (X60Qx_197 === 62);
  } else {
    X60Qx_194 = false;
  }
  if (X60Qx_194) {
    var X60Qx_198;
    var X60Qx_199;
    var X60Qx_200 = len_4_sysvq0asl((t_2 + 4));
    var X60Qx_201 = getQ_9_sysvq0asl((t_2 + 4), ((X60Qx_200 - 2) | 0));
    if ((X60Qx_201 === 45)) {
      X60Qx_199 = true;
    } else {
      var X60Qx_202 = len_4_sysvq0asl((t_2 + 4));
      var X60Qx_203 = getQ_9_sysvq0asl((t_2 + 4), ((X60Qx_202 - 2) | 0));
      X60Qx_199 = (X60Qx_203 === 126);
    }
    if (X60Qx_199) {
      X60Qx_198 = true;
    } else {
      var X60Qx_204 = len_4_sysvq0asl((t_2 + 4));
      var X60Qx_205 = getQ_9_sysvq0asl((t_2 + 4), ((X60Qx_204 - 2) | 0));
      X60Qx_198 = (X60Qx_205 === 61);
    }
    X60Qx_193 = X60Qx_198;
  } else {
    X60Qx_193 = false;
  }
  if (X60Qx_193) {
    return 0;
  }
  var c_2 = getQ_9_sysvq0asl((t_2 + 4), 0);
  var X60Qx_206 = len_4_sysvq0asl((t_2 + 4));
  var X60Qx_207 = getQ_9_sysvq0asl((t_2 + 4), ((X60Qx_206 - 1) | 0));
  var asgn_0 = (X60Qx_207 === 61);
  switch (c_2) {
    case 36:
    case 94:
      {
        var X60Qx_1;
        if (asgn_0) {
          X60Qx_1 = 1;
        } else {
          X60Qx_1 = 10;
        }
        return X60Qx_1;
      }
      break;
    case 42:
    case 47:
    case 37:
    case 92:
      {
        var X60Qx_2;
        if (asgn_0) {
          X60Qx_2 = 1;
        } else {
          X60Qx_2 = 9;
        }
        return X60Qx_2;
      }
      break;
    case 126:
      {
        return 8;
      }
      break;
    case 43:
    case 45:
    case 124:
      {
        var X60Qx_3;
        if (asgn_0) {
          X60Qx_3 = 1;
        } else {
          X60Qx_3 = 8;
        }
        return X60Qx_3;
      }
      break;
    case 38:
      {
        var X60Qx_4;
        if (asgn_0) {
          X60Qx_4 = 1;
        } else {
          X60Qx_4 = 7;
        }
        return X60Qx_4;
      }
      break;
    case 61:
    case 60:
    case 62:
    case 33:
      {
        return 5;
      }
      break;
    case 46:
      {
        var X60Qx_5;
        if (asgn_0) {
          X60Qx_5 = 1;
        } else {
          X60Qx_5 = 6;
        }
        return X60Qx_5;
      }
      break;
    case 63:
      {
        return 2;
      }
      break;
    default:
      {
        var X60Qx_6;
        if (asgn_0) {
          X60Qx_6 = 1;
        } else {
          X60Qx_6 = 2;
        }
        return X60Qx_6;
      }
      break;
  }
  return result_8;
}

function startsExpr_0_parq39nt2(t_3) {
  let result_9;
  let X60Qx_7;
  switch (mem.u8At(t_3)) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 5:
    case 6:
    case 7:
    case 8:
    case 10:
    case 12:
    case 14:
      {
        X60Qx_7 = true;
      }
      break;
    default:
      {
        X60Qx_7 = false;
      }
      break;
  }
  result_9 = X60Qx_7;
  return result_9;
}

function continuesLine_0_parq39nt2(prev_0) {
  let result_10;
  let X60Qx_8;
  switch (mem.u8At(prev_0)) {
    case 16:
    case 9:
    case 19:
      {
        X60Qx_8 = true;
      }
      break;
    case 2:
      {
        let X60Qx_208 = isBinaryOp_0_parq39nt2(prev_0);
        X60Qx_8 = X60Qx_208;
      }
      break;
    default:
      {
        X60Qx_8 = false;
      }
      break;
  }
  result_10 = X60Qx_8;
  return result_10;
}

function lineEnd_0_parq39nt2(ps_6, startIdx_0) {
  whileStmtLabel_0: {
    var result_11;
    var i_6 = allocFixed(4);
    mem.setI32(i_6, startIdx_0);
    var depth_0 = allocFixed(4);
    mem.setI32(depth_0, 0);
    {
      while (true) {
        var X60Qtmp_6 = allocFixed(72);
        mem.copy(X60Qtmp_6, tok_0_parq39nt2(ps_6, mem.i32(i_6)), 72);
        if ((!(mem.u8At(X60Qtmp_6) === 0))) {
          var t_7 = allocFixed(72);
          mem.copy(t_7, tok_0_parq39nt2(ps_6, mem.i32(i_6)), 72);
          var X60Qx_209;
          if ((mem.i32(depth_0) === 0)) {
            X60Qx_209 = (startIdx_0 < mem.i32(i_6));
          } else {
            X60Qx_209 = false;
          }
          if (X60Qx_209) {
            var prev_2 = allocFixed(72);
            mem.copy(prev_2, tok_0_parq39nt2(ps_6, ((mem.i32(i_6) - 1) | 0)), 72);
            var X60Qx_210;
            if ((!(mem.i32((t_7 + 40)) === mem.i32((prev_2 + 40))))) {
              var X60Qx_211 = continuesLine_0_parq39nt2(prev_2);
              X60Qx_210 = (!X60Qx_211);
            } else {
              X60Qx_210 = false;
            }
            if (X60Qx_210) {
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(prev_2);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_7);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_6);
              break whileStmtLabel_0;
            }
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(prev_2);
          }
          var X60Qx_212 = isOpenBracket_0_parq39nt2(mem.u8At(t_7));
          if (X60Qx_212) {
            inc_1_I6wjjge_cmdqs323n1(depth_0);
          } else {
            var X60Qx_213 = isCloseBracket_0_parq39nt2(mem.u8At(t_7));
            if (X60Qx_213) {
              if ((0 < mem.i32(depth_0))) {
                dec_1_I0nzoz91_envto7w6l1(depth_0);
              }
            }
          }
          inc_1_I6wjjge_cmdqs323n1(i_6);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_7);
        } else {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_6);
          break;
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_6);
      }
    }
  }
  result_11 = mem.i32(i_6);
  return result_11;
}

function matchClose_0_parq39nt2(ps_7, openIdx_0) {
  whileStmtLabel_0: {
    var result_12;
    var depth_1 = allocFixed(4);
    mem.setI32(depth_1, 0);
    var i_7 = allocFixed(4);
    mem.setI32(i_7, openIdx_0);
    {
      while (true) {
        var X60Qtmp_7 = allocFixed(72);
        mem.copy(X60Qtmp_7, tok_0_parq39nt2(ps_7, mem.i32(i_7)), 72);
        if ((!(mem.u8At(X60Qtmp_7) === 0))) {
          var X60Qtmp_8 = allocFixed(72);
          mem.copy(X60Qtmp_8, tok_0_parq39nt2(ps_7, mem.i32(i_7)), 72);
          var k_4 = mem.u8At(X60Qtmp_8);
          var X60Qx_214 = isOpenBracket_0_parq39nt2(k_4);
          if (X60Qx_214) {
            inc_1_I6wjjge_cmdqs323n1(depth_1);
          } else {
            var X60Qx_215 = isCloseBracket_0_parq39nt2(k_4);
            if (X60Qx_215) {
              dec_1_I0nzoz91_envto7w6l1(depth_1);
              if ((mem.i32(depth_1) === 0)) {
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_8);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_7);
                return mem.i32(i_7);
              }
            }
          }
          inc_1_I6wjjge_cmdqs323n1(i_7);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_8);
        } else {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_7);
          break;
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_7);
      }
    }
  }
  result_12 = mem.i32(i_7);
  return result_12;
}

function lineIndentOf_0_parq39nt2(ps_8, idx_0) {
  whileStmtLabel_0: {
    var result_13;
    var i_8 = allocFixed(4);
    mem.setI32(i_8, idx_0);
    {
      while (true) {
        var X60Qx_54;
        if ((0 < mem.i32(i_8))) {
          var X60Qtmp_9 = allocFixed(72);
          mem.copy(X60Qtmp_9, tok_0_parq39nt2(ps_8, mem.i32(i_8)), 72);
          X60Qx_54 = (mem.i32((X60Qtmp_9 + 52)) < 0);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_9);
        } else {
          X60Qx_54 = false;
        }
        if (X60Qx_54) {
          dec_1_I0nzoz91_envto7w6l1(i_8);
        } else {
          break;
        }
      }
    }
  }
  var X60Qx_9;
  var X60Qtmp_10 = allocFixed(72);
  mem.copy(X60Qtmp_10, tok_0_parq39nt2(ps_8, mem.i32(i_8)), 72);
  if ((0 <= mem.i32((X60Qtmp_10 + 52)))) {
    var X60Qtmp_11 = allocFixed(72);
    mem.copy(X60Qtmp_11, tok_0_parq39nt2(ps_8, mem.i32(i_8)), 72);
    X60Qx_9 = mem.i32((X60Qtmp_11 + 52));
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_11);
  } else {
    var X60Qtmp_12 = allocFixed(72);
    mem.copy(X60Qtmp_12, tok_0_parq39nt2(ps_8, idx_0), 72);
    X60Qx_9 = mem.i32((X60Qtmp_12 + 44));
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_12);
  }
  result_13 = X60Qx_9;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_10);
  return result_13;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_10);
  return result_13;
}

function matchOpen_0_parq39nt2(ps_9, closeIdx_0) {
  whileStmtLabel_0: {
    var result_14;
    var depth_2 = allocFixed(4);
    mem.setI32(depth_2, 0);
    var i_9 = allocFixed(4);
    mem.setI32(i_9, closeIdx_0);
    {
      while ((0 <= mem.i32(i_9))) {
        var X60Qtmp_13 = allocFixed(72);
        mem.copy(X60Qtmp_13, tok_0_parq39nt2(ps_9, mem.i32(i_9)), 72);
        var k_5 = mem.u8At(X60Qtmp_13);
        var X60Qx_216 = isCloseBracket_0_parq39nt2(k_5);
        if (X60Qx_216) {
          inc_1_I6wjjge_cmdqs323n1(depth_2);
        } else {
          var X60Qx_217 = isOpenBracket_0_parq39nt2(k_5);
          if (X60Qx_217) {
            dec_1_I0nzoz91_envto7w6l1(depth_2);
            if ((mem.i32(depth_2) === 0)) {
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_13);
              return mem.i32(i_9);
            }
          }
        }
        dec_1_I0nzoz91_envto7w6l1(i_9);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_13);
      }
    }
  }
  result_14 = closeIdx_0;
  return result_14;
}

function findSplit_0_parq39nt2(ps_10, lo_2, hi_2) {
  whileStmtLabel_0: {
    var result_15;
    var depth_3 = allocFixed(4);
    mem.setI32(depth_3, 0);
    var bestPrec_0 = 1000;
    result_15 = -1;
    var i_10 = allocFixed(4);
    mem.setI32(i_10, lo_2);
    {
      while ((mem.i32(i_10) < hi_2)) {
        var t_8 = allocFixed(72);
        mem.copy(t_8, tok_0_parq39nt2(ps_10, mem.i32(i_10)), 72);
        var X60Qx_218 = isOpenBracket_0_parq39nt2(mem.u8At(t_8));
        if (X60Qx_218) {
          inc_1_I6wjjge_cmdqs323n1(depth_3);
        } else {
          var X60Qx_219 = isCloseBracket_0_parq39nt2(mem.u8At(t_8));
          if (X60Qx_219) {
            if ((0 < mem.i32(depth_3))) {
              dec_1_I0nzoz91_envto7w6l1(depth_3);
            }
          } else {
            var X60Qx_220;
            var X60Qx_221;
            var X60Qx_222;
            if ((mem.i32(depth_3) === 0)) {
              X60Qx_222 = (lo_2 < mem.i32(i_10));
            } else {
              X60Qx_222 = false;
            }
            if (X60Qx_222) {
              var X60Qx_223 = isBinaryOp_0_parq39nt2(t_8);
              X60Qx_221 = X60Qx_223;
            } else {
              X60Qx_221 = false;
            }
            if (X60Qx_221) {
              var X60Qx_224 = opIsInfix_0_parq39nt2(ps_10, mem.i32(i_10), lo_2);
              X60Qx_220 = X60Qx_224;
            } else {
              X60Qx_220 = false;
            }
            if (X60Qx_220) {
              var p_1 = precedenceOf_0_parq39nt2(t_8);
              if ((p_1 <= bestPrec_0)) {
                bestPrec_0 = p_1;
                result_15 = mem.i32(i_10);
              }
            }
          }
        }
        inc_1_I6wjjge_cmdqs323n1(i_10);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_8);
      }
    }
  }
  return result_15;
}

function findAssign_0_parq39nt2(ps_11, lo_3, hi_3) {
  whileStmtLabel_0: {
    var result_16;
    var depth_4 = allocFixed(4);
    mem.setI32(depth_4, 0);
    result_16 = -1;
    var i_11 = allocFixed(4);
    mem.setI32(i_11, lo_3);
    {
      while ((mem.i32(i_11) < hi_3)) {
        var t_9 = allocFixed(72);
        mem.copy(t_9, tok_0_parq39nt2(ps_11, mem.i32(i_11)), 72);
        var X60Qx_225 = isOpenBracket_0_parq39nt2(mem.u8At(t_9));
        if (X60Qx_225) {
          inc_1_I6wjjge_cmdqs323n1(depth_4);
        } else {
          var X60Qx_226 = isCloseBracket_0_parq39nt2(mem.u8At(t_9));
          if (X60Qx_226) {
            if ((0 < mem.i32(depth_4))) {
              dec_1_I0nzoz91_envto7w6l1(depth_4);
            }
          } else {
            var X60Qx_227;
            var X60Qx_228;
            if ((mem.i32(depth_4) === 0)) {
              X60Qx_228 = (mem.u8At(t_9) === 9);
            } else {
              X60Qx_228 = false;
            }
            if (X60Qx_228) {
              var X60Qx_229 = eqQ_20_sysvq0asl((t_9 + 4), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 15617);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              X60Qx_227 = X60Qx_229;
            } else {
              X60Qx_227 = false;
            }
            if (X60Qx_227) {
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_9);
              return mem.i32(i_11);
            }
          }
        }
        inc_1_I6wjjge_cmdqs323n1(i_11);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_9);
      }
    }
  }
  return result_16;
}

function splitArgs_0_parq39nt2(ps_12, lo_4, hi_4) {
  whileStmtLabel_0: {
    var result_17 = allocFixed(8);
    eQwasMoved_1_Ix88qzs1_mat7cnfv21(result_17);
    eQdestroy_1_Iv9ij5i1_mat7cnfv21(result_17);
    var X60Qx_230 = allocFixed(8);
    mem.copy(X60Qx_230, newSeqUninit_0_Iggfvwp_mat7cnfv21(0), 8);
    mem.copy(result_17, X60Qx_230, 8);
    if ((hi_4 <= lo_4)) {
      return result_17;
    }
    add_0_I8kd4i4_parq39nt2(result_17, lo_4);
    var depth_5 = allocFixed(4);
    mem.setI32(depth_5, 0);
    var i_12 = allocFixed(4);
    mem.setI32(i_12, lo_4);
    {
      while ((mem.i32(i_12) < hi_4)) {
        var t_10 = allocFixed(72);
        mem.copy(t_10, tok_0_parq39nt2(ps_12, mem.i32(i_12)), 72);
        var X60Qx_231 = isOpenBracket_0_parq39nt2(mem.u8At(t_10));
        if (X60Qx_231) {
          inc_1_I6wjjge_cmdqs323n1(depth_5);
        } else {
          var X60Qx_232 = isCloseBracket_0_parq39nt2(mem.u8At(t_10));
          if (X60Qx_232) {
            if ((0 < mem.i32(depth_5))) {
              dec_1_I0nzoz91_envto7w6l1(depth_5);
            }
          } else {
            var X60Qx_233;
            if ((mem.i32(depth_5) === 0)) {
              X60Qx_233 = (mem.u8At(t_10) === 16);
            } else {
              X60Qx_233 = false;
            }
            if (X60Qx_233) {
              if ((((mem.i32(i_12) + 1) | 0) < hi_4)) {
                add_0_I8kd4i4_parq39nt2(result_17, ((mem.i32(i_12) + 1) | 0));
              }
            }
          }
        }
        inc_1_I6wjjge_cmdqs323n1(i_12);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_10);
      }
    }
  }
  return result_17;
}

function depth0Colon_0_parq39nt2(ps_20, lo_7, hi_7) {
  whileStmtLabel_0: {
    var result_18;
    var depth_6 = allocFixed(4);
    mem.setI32(depth_6, 0);
    result_18 = -1;
    var i_13 = allocFixed(4);
    mem.setI32(i_13, lo_7);
    {
      while ((mem.i32(i_13) < hi_7)) {
        var t_11 = allocFixed(72);
        mem.copy(t_11, tok_0_parq39nt2(ps_20, mem.i32(i_13)), 72);
        var X60Qx_234 = isOpenBracket_0_parq39nt2(mem.u8At(t_11));
        if (X60Qx_234) {
          inc_1_I6wjjge_cmdqs323n1(depth_6);
        } else {
          var X60Qx_235 = isCloseBracket_0_parq39nt2(mem.u8At(t_11));
          if (X60Qx_235) {
            if ((0 < mem.i32(depth_6))) {
              dec_1_I0nzoz91_envto7w6l1(depth_6);
            }
          } else {
            var X60Qx_236;
            if ((mem.i32(depth_6) === 0)) {
              X60Qx_236 = (mem.u8At(t_11) === 18);
            } else {
              X60Qx_236 = false;
            }
            if (X60Qx_236) {
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_11);
              return mem.i32(i_13);
            }
          }
        }
        inc_1_I6wjjge_cmdqs323n1(i_13);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_11);
      }
    }
  }
  return result_18;
}

function findPostfix_0_parq39nt2(ps_21, lo_8, hi_8, kind_0) {
  whileStmtLabel_0: {
    var result_19;
    var depth_7 = allocFixed(4);
    mem.setI32(depth_7, 0);
    result_19 = -1;
    mem.setI32(kind_0, 0);
    var i_14 = allocFixed(4);
    mem.setI32(i_14, lo_8);
    {
      while ((mem.i32(i_14) < hi_8)) {
        var t_12 = allocFixed(72);
        mem.copy(t_12, tok_0_parq39nt2(ps_21, mem.i32(i_14)), 72);
        var X60Qx_237;
        if ((mem.i32(depth_7) === 0)) {
          X60Qx_237 = (lo_8 < mem.i32(i_14));
        } else {
          X60Qx_237 = false;
        }
        if (X60Qx_237) {
          switch (mem.u8At(t_12)) {
            case 19:
              {
                result_19 = mem.i32(i_14);
                mem.setI32(kind_0, 1);
              }
              break;
            case 12:
              {
                result_19 = mem.i32(i_14);
                mem.setI32(kind_0, 2);
              }
              break;
            case 14:
              {
                result_19 = mem.i32(i_14);
                mem.setI32(kind_0, 3);
              }
              break;
            case 10:
              {
                result_19 = mem.i32(i_14);
                mem.setI32(kind_0, 4);
              }
              break;
            default:
              {
              }
              break;
          }
        }
        var X60Qx_238 = isOpenBracket_0_parq39nt2(mem.u8At(t_12));
        if (X60Qx_238) {
          inc_1_I6wjjge_cmdqs323n1(depth_7);
        } else {
          var X60Qx_239 = isCloseBracket_0_parq39nt2(mem.u8At(t_12));
          if (X60Qx_239) {
            if ((0 < mem.i32(depth_7))) {
              dec_1_I0nzoz91_envto7w6l1(depth_7);
            }
          }
        }
        inc_1_I6wjjge_cmdqs323n1(i_14);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_12);
      }
    }
  }
  return result_19;
}

function parseArg_0_parq39nt2(ps_22, b_9, lo_9, hi_9, pl_9, pc_9) {
  let head_0 = allocFixed(72);
  mem.copy(head_0, tok_0_parq39nt2(ps_22, lo_9), 72);
  let X60Qx_240;
  if ((mem.u8At(head_0) === 2)) {
    let X60Qx_241;
    let X60Qx_242 = eqQ_20_sysvq0asl((head_0 + 4), (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 6711554);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    if (X60Qx_242) {
      X60Qx_241 = true;
    } else {
      let X60Qx_243 = eqQ_20_sysvq0asl((head_0 + 4), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1935762430);
        mem.setU32((_o + 4), strlit_0_I4956278306908871092_parq39nt2);
        return _o;
      })());
      X60Qx_241 = X60Qx_243;
    }
    X60Qx_240 = X60Qx_241;
  } else {
    X60Qx_240 = false;
  }
  let guardKw_0 = X60Qx_240;
  if ((!guardKw_0)) {
    let ci_0 = depth0Colon_0_parq39nt2(ps_22, lo_9, hi_9);
    if ((0 <= ci_0)) {
      let op_0 = allocFixed(72);
      mem.copy(op_0, tok_0_parq39nt2(ps_22, ci_0), 72);
      addTree_0_nifjp9lau1(b_9, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 7760642);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_22, b_9, mem.i32((op_0 + 40)), mem.i32((op_0 + 44)), pl_9, pc_9, false);
      parseExprRange_1_parq39nt2(ps_22, b_9, lo_9, ci_0, mem.i32((op_0 + 40)), mem.i32((op_0 + 44)));
      parseExprRange_1_parq39nt2(ps_22, b_9, ((ci_0 + 1) | 0), hi_9, mem.i32((op_0 + 40)), mem.i32((op_0 + 44)));
      endTree_0_nifjp9lau1(b_9);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(op_0);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(head_0);
      return;
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(op_0);
    }
    let ei_0 = findAssign_0_parq39nt2(ps_22, lo_9, hi_9);
    if ((0 <= ei_0)) {
      let op_1 = allocFixed(72);
      mem.copy(op_1, tok_0_parq39nt2(ps_22, ei_0), 72);
      addTree_0_nifjp9lau1(b_9, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 7763458);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_22, b_9, mem.i32((op_1 + 40)), mem.i32((op_1 + 44)), pl_9, pc_9, false);
      parseExprRange_1_parq39nt2(ps_22, b_9, lo_9, ei_0, mem.i32((op_1 + 40)), mem.i32((op_1 + 44)));
      parseExprRange_1_parq39nt2(ps_22, b_9, ((ei_0 + 1) | 0), hi_9, mem.i32((op_1 + 40)), mem.i32((op_1 + 44)));
      endTree_0_nifjp9lau1(b_9);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(op_1);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(head_0);
      return;
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(op_1);
    }
  }
  parseExprRange_1_parq39nt2(ps_22, b_9, lo_9, hi_9, pl_9, pc_9);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(head_0);
}

function parseArgList_0_parq39nt2(ps_23, b_10, lo_10, hi_10, pl_10, pc_10) {
  forStmtLabel_0: {
    var starts_0 = allocFixed(8);
    mem.copy(starts_0, splitArgs_0_parq39nt2(ps_23, lo_10, hi_10), 8);
    {
      whileStmtLabel_1: {
        var X60Qlf_4 = 0;
        var X60Qlf_5 = len_3_I0v1j8d_parq39nt2(starts_0);
        var X60Qlf_6 = allocFixed(4);
        mem.setI32(X60Qlf_6, X60Qlf_4);
        {
          while ((mem.i32(X60Qlf_6) < X60Qlf_5)) {
            {
              var X60Qx_244 = getQ_7_Ir8kccm_parq39nt2(starts_0, mem.i32(X60Qlf_6));
              var X60Qii_2 = allocFixed(4);
              mem.setI32(X60Qii_2, mem.i32(X60Qx_244));
              var X60Qx_10;
              var X60Qx_245 = len_3_I0v1j8d_parq39nt2(starts_0);
              if ((((mem.i32(X60Qlf_6) + 1) | 0) < X60Qx_245)) {
                var X60Qx_246 = getQ_7_Ir8kccm_parq39nt2(starts_0, ((mem.i32(X60Qlf_6) + 1) | 0));
                X60Qx_10 = ((mem.i32(X60Qx_246) - 1) | 0);
              } else {
                X60Qx_10 = hi_10;
              }
              var X60Qii_3 = allocFixed(4);
              mem.setI32(X60Qii_3, X60Qx_10);
              if ((mem.i32(X60Qii_2) < mem.i32(X60Qii_3))) {
                parseArg_0_parq39nt2(ps_23, b_10, mem.i32(X60Qii_2), mem.i32(X60Qii_3), pl_10, pc_10);
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_6);
          }
        }
      }
    }
  }
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_0);
}

function parseIfExpr_0_parq39nt2(ps_24, b_11, lo_11, hi_11, pl_11, pc_11, bare_0, tag_1) {
  whileStmtLabel_0: {
    var ifTok_0 = allocFixed(72);
    mem.copy(ifTok_0, tok_0_parq39nt2(ps_24, lo_11), 72);
    addTree_0_nifjp9lau1(b_11, tag_1);
    emitInfo_0_parq39nt2(ps_24, b_11, mem.i32((ifTok_0 + 40)), mem.i32((ifTok_0 + 44)), pl_11, pc_11, false);
    var i_16 = lo_11;
    {
      while ((i_16 < hi_11)) {
        whileStmtLabel_1: {
          var kw_0 = allocFixed(72);
          mem.copy(kw_0, tok_0_parq39nt2(ps_24, i_16), 72);
          var X60Qx_247;
          if ((mem.u8At(kw_0) === 2)) {
            var X60Qx_248 = eqQ_20_sysvq0asl((kw_0 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1936483838);
              mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
              return _o;
            })());
            X60Qx_247 = X60Qx_248;
          } else {
            X60Qx_247 = false;
          }
          var isElse_0 = X60Qx_247;
          var depth_8 = allocFixed(4);
          mem.setI32(depth_8, 0);
          var colon_0 = -1;
          var nxt_2 = hi_11;
          var j_0 = allocFixed(4);
          mem.setI32(j_0, ((i_16 + 1) | 0));
          {
            while ((mem.i32(j_0) < hi_11)) {
              var t_13 = allocFixed(72);
              mem.copy(t_13, tok_0_parq39nt2(ps_24, mem.i32(j_0)), 72);
              var X60Qx_249 = isOpenBracket_0_parq39nt2(mem.u8At(t_13));
              if (X60Qx_249) {
                inc_1_I6wjjge_cmdqs323n1(depth_8);
              } else {
                var X60Qx_250 = isCloseBracket_0_parq39nt2(mem.u8At(t_13));
                if (X60Qx_250) {
                  if ((0 < mem.i32(depth_8))) {
                    dec_1_I0nzoz91_envto7w6l1(depth_8);
                  }
                } else {
                  var X60Qx_251;
                  var X60Qx_252;
                  if ((mem.i32(depth_8) === 0)) {
                    X60Qx_252 = (mem.u8At(t_13) === 18);
                  } else {
                    X60Qx_252 = false;
                  }
                  if (X60Qx_252) {
                    X60Qx_251 = (colon_0 < 0);
                  } else {
                    X60Qx_251 = false;
                  }
                  if (X60Qx_251) {
                    colon_0 = mem.i32(j_0);
                  } else {
                    var X60Qx_253;
                    var X60Qx_254;
                    if ((mem.i32(depth_8) === 0)) {
                      X60Qx_254 = (mem.u8At(t_13) === 2);
                    } else {
                      X60Qx_254 = false;
                    }
                    if (X60Qx_254) {
                      var X60Qx_255;
                      var X60Qx_256 = eqQ_20_sysvq0asl((t_13 + 4), (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 1768711678);
                        mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
                        return _o;
                      })());
                      if (X60Qx_256) {
                        X60Qx_255 = true;
                      } else {
                        var X60Qx_257 = eqQ_20_sysvq0asl((t_13 + 4), (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1936483838);
                          mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
                          return _o;
                        })());
                        X60Qx_255 = X60Qx_257;
                      }
                      X60Qx_253 = X60Qx_255;
                    } else {
                      X60Qx_253 = false;
                    }
                    if (X60Qx_253) {
                      nxt_2 = mem.i32(j_0);
                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_13);
                      break whileStmtLabel_1;
                    }
                  }
                }
              }
              inc_1_I6wjjge_cmdqs323n1(j_0);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_13);
            }
          }
        }
        var bodyLo_0 = ((colon_0 + 1) | 0);
        if (isElse_0) {
          addTree_0_nifjp9lau1(b_11, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1936483838);
            mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_24, b_11, mem.i32((kw_0 + 40)), mem.i32((kw_0 + 44)), mem.i32((ifTok_0 + 40)), mem.i32((ifTok_0 + 44)), false);
          var bt_0 = allocFixed(72);
          mem.copy(bt_0, tok_0_parq39nt2(ps_24, bodyLo_0), 72);
          if (bare_0) {
            parseExprRange_1_parq39nt2(ps_24, b_11, bodyLo_0, nxt_2, mem.i32((kw_0 + 40)), mem.i32((kw_0 + 44)));
          } else {
            addTree_0_nifjp9lau1(b_11, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1836348414);
              mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_24, b_11, mem.i32((bt_0 + 40)), mem.i32((bt_0 + 44)), mem.i32((kw_0 + 40)), mem.i32((kw_0 + 44)), false);
            parseExprRange_1_parq39nt2(ps_24, b_11, bodyLo_0, nxt_2, mem.i32((bt_0 + 40)), mem.i32((bt_0 + 44)));
            endTree_0_nifjp9lau1(b_11);
          }
          endTree_0_nifjp9lau1(b_11);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(bt_0);
        } else {
          var ct_0 = allocFixed(72);
          mem.copy(ct_0, tok_0_parq39nt2(ps_24, ((i_16 + 1) | 0)), 72);
          addTree_0_nifjp9lau1(b_11, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1768711678);
            mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_24, b_11, mem.i32((ct_0 + 40)), mem.i32((ct_0 + 44)), mem.i32((ifTok_0 + 40)), mem.i32((ifTok_0 + 44)), false);
          parseExprRange_1_parq39nt2(ps_24, b_11, ((i_16 + 1) | 0), colon_0, mem.i32((ct_0 + 40)), mem.i32((ct_0 + 44)));
          var bt_1 = allocFixed(72);
          mem.copy(bt_1, tok_0_parq39nt2(ps_24, bodyLo_0), 72);
          if (bare_0) {
            parseExprRange_1_parq39nt2(ps_24, b_11, bodyLo_0, nxt_2, mem.i32((ct_0 + 40)), mem.i32((ct_0 + 44)));
          } else {
            addTree_0_nifjp9lau1(b_11, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1836348414);
              mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_24, b_11, mem.i32((bt_1 + 40)), mem.i32((bt_1 + 44)), mem.i32((ct_0 + 40)), mem.i32((ct_0 + 44)), false);
            parseExprRange_1_parq39nt2(ps_24, b_11, bodyLo_0, nxt_2, mem.i32((bt_1 + 40)), mem.i32((bt_1 + 44)));
            endTree_0_nifjp9lau1(b_11);
          }
          endTree_0_nifjp9lau1(b_11);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(bt_1);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(ct_0);
        }
        i_16 = nxt_2;
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_0);
      }
    }
  }
  endTree_0_nifjp9lau1(b_11);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(ifTok_0);
}

function parseCastExpr_0_parq39nt2(ps_25, b_12, lo_12, hi_12, pl_12, pc_12) {
  let castTok_0 = allocFixed(72);
  mem.copy(castTok_0, tok_0_parq39nt2(ps_25, lo_12), 72);
  addTree_0_nifjp9lau1(b_12, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1935762430);
    mem.setU32((_o + 4), strlit_0_I13909093427330098489_parq39nt2);
    return _o;
  })());
  emitInfo_0_parq39nt2(ps_25, b_12, mem.i32((castTok_0 + 40)), mem.i32((castTok_0 + 44)), pl_12, pc_12, false);
  let lb_0 = ((lo_12 + 1) | 0);
  let rb_0 = matchClose_0_parq39nt2(ps_25, lb_0);
  let X60Qx_258 = parseType_1_parq39nt2(ps_25, b_12, ((lb_0 + 1) | 0), mem.i32((castTok_0 + 40)), mem.i32((castTok_0 + 44)));
  let lp_0 = ((rb_0 + 1) | 0);
  let rp_0 = matchClose_0_parq39nt2(ps_25, lp_0);
  parseExprRange_1_parq39nt2(ps_25, b_12, ((lp_0 + 1) | 0), rp_0, mem.i32((castTok_0 + 40)), mem.i32((castTok_0 + 44)));
  endTree_0_nifjp9lau1(b_12);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(castTok_0);
}

function parseCmdKw_0_parq39nt2(ps_26, b_13, lo_13, hi_13, pl_13, pc_13) {
  let kw_1 = allocFixed(72);
  mem.copy(kw_1, tok_0_parq39nt2(ps_26, lo_13), 72);
  addTree_0_nifjp9lau1(b_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684890371);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  emitInfo_0_parq39nt2(ps_26, b_13, mem.i32((kw_1 + 40)), mem.i32((kw_1 + 44)), pl_13, pc_13, false);
  addIdent_0_nifjp9lau1(b_13, (kw_1 + 4));
  emitInfo_0_parq39nt2(ps_26, b_13, mem.i32((kw_1 + 40)), mem.i32((kw_1 + 44)), mem.i32((kw_1 + 40)), mem.i32((kw_1 + 44)), false);
  parseArgList_0_parq39nt2(ps_26, b_13, ((lo_13 + 1) | 0), hi_13, mem.i32((kw_1 + 40)), mem.i32((kw_1 + 44)));
  endTree_0_nifjp9lau1(b_13);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_1);
}

function parsePrimaryRange_0_parq39nt2(ps_27, b_14, lo_14, hi_14, pl_14, pc_14) {
  var t_14 = allocFixed(72);
  mem.copy(t_14, tok_0_parq39nt2(ps_27, lo_14), 72);
  var X60Qx_259;
  var X60Qx_260;
  if ((mem.u8At(t_14) === 9)) {
    var X60Qx_261 = eqQ_20_sysvq0asl((t_14 + 4), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 11521);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    X60Qx_260 = X60Qx_261;
  } else {
    X60Qx_260 = false;
  }
  if (X60Qx_260) {
    X60Qx_259 = (((lo_14 + 2) | 0) === hi_14);
  } else {
    X60Qx_259 = false;
  }
  if (X60Qx_259) {
    var n_0 = allocFixed(72);
    mem.copy(n_0, tok_0_parq39nt2(ps_27, ((lo_14 + 1) | 0)), 72);
    var X60Qx_262;
    var X60Qx_263;
    var X60Qx_264;
    if ((mem.u8At(n_0) === 3)) {
      X60Qx_264 = true;
    } else {
      X60Qx_264 = (mem.u8At(n_0) === 4);
    }
    if (X60Qx_264) {
      X60Qx_263 = (mem.i32((n_0 + 40)) === mem.i32((t_14 + 40)));
    } else {
      X60Qx_263 = false;
    }
    if (X60Qx_263) {
      X60Qx_262 = (mem.i32((n_0 + 44)) === ((mem.i32((t_14 + 44)) + 1) | 0));
    } else {
      X60Qx_262 = false;
    }
    if (X60Qx_262) {
      var suf_0 = allocFixed(8);
      mem.copy(suf_0, (n_0 + 32), 8);
      nimStrWasMoved((n_0 + 32));
      if ((mem.u8At(n_0) === 3)) {
        var v_0 = BigInt.asIntN(64, (-mem.i64b((n_0 + 16))));
        var X60Qx_265 = len_4_sysvq0asl(suf_0);
        if ((0 < X60Qx_265)) {
          addTree_0_nifjp9lau1(b_14, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1718973187);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
          var X60Qx_266 = getQ_9_sysvq0asl(suf_0, 0);
          if ((X60Qx_266 === 117)) {
            addUIntLit_0_nifjp9lau1(b_14, BigInt.asUintN(64, v_0));
          } else {
            addIntLit_0_nifjp9lau1(b_14, v_0);
          }
          addStrLit_0_nifjp9lau1(b_14, suf_0);
          endTree_0_nifjp9lau1(b_14);
        } else {
          var X60Qx_267;
          if ((2147483647n < v_0)) {
            X60Qx_267 = true;
          } else {
            X60Qx_267 = (v_0 < -2147483648n);
          }
          if (X60Qx_267) {
            addTree_0_nifjp9lau1(b_14, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1718973187);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
            addIntLit_0_nifjp9lau1(b_14, v_0);
            addStrLit_0_nifjp9lau1(b_14, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 875981059);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            endTree_0_nifjp9lau1(b_14);
          } else {
            addIntLit_0_nifjp9lau1(b_14, v_0);
            emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
          }
        }
      } else {
        var X60Qx_268 = len_4_sysvq0asl(suf_0);
        if ((0 < X60Qx_268)) {
          addTree_0_nifjp9lau1(b_14, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1718973187);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
          addFloatLit_0_nifjp9lau1(b_14, (-mem.f64((n_0 + 24))), 0, 0, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 0);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          addStrLit_0_nifjp9lau1(b_14, suf_0);
          endTree_0_nifjp9lau1(b_14);
        } else {
          addFloatLit_0_nifjp9lau1(b_14, (-mem.f64((n_0 + 24))), ((mem.i32((t_14 + 44)) - pc_14) | 0), ((mem.i32((t_14 + 40)) - pl_14) | 0), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 0);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
        }
      }
      nimStrDestroy(suf_0);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(n_0);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
      return;
      nimStrDestroy(suf_0);
    }
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(n_0);
  }
  var X60Qx_269;
  var X60Qx_270;
  if ((mem.u8At(t_14) === 1)) {
    X60Qx_270 = true;
  } else {
    X60Qx_270 = (mem.u8At(t_14) === 2);
  }
  if (X60Qx_270) {
    X60Qx_269 = (((lo_14 + 2) | 0) === hi_14);
  } else {
    X60Qx_269 = false;
  }
  if (X60Qx_269) {
    var s_8 = allocFixed(72);
    mem.copy(s_8, tok_0_parq39nt2(ps_27, ((lo_14 + 1) | 0)), 72);
    var X60Qx_271;
    var X60Qx_272;
    var X60Qx_273;
    var X60Qx_274;
    if ((mem.u8At(s_8) === 5)) {
      X60Qx_274 = true;
    } else {
      X60Qx_274 = (mem.u8At(s_8) === 6);
    }
    if (X60Qx_274) {
      X60Qx_273 = true;
    } else {
      X60Qx_273 = (mem.u8At(s_8) === 7);
    }
    if (X60Qx_273) {
      X60Qx_272 = (mem.i32((s_8 + 40)) === mem.i32((t_14 + 40)));
    } else {
      X60Qx_272 = false;
    }
    if (X60Qx_272) {
      var X60Qx_275 = len_4_sysvq0asl((t_14 + 4));
      X60Qx_271 = (mem.i32((s_8 + 44)) === ((mem.i32((t_14 + 44)) + X60Qx_275) | 0));
    } else {
      X60Qx_271 = false;
    }
    if (X60Qx_271) {
      addTree_0_nifjp9lau1(b_14, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1818321918);
        mem.setU32((_o + 4), strlit_0_I9217337746930322866_parq39nt2);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
      addIdent_0_nifjp9lau1(b_14, (t_14 + 4));
      emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), false);
      addTree_0_nifjp9lau1(b_14, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1718973187);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((s_8 + 40)), mem.i32((s_8 + 44)), mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), false);
      addStrLit_0_nifjp9lau1(b_14, (s_8 + 4));
      addStrLit_0_nifjp9lau1(b_14, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 20993);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      endTree_0_nifjp9lau1(b_14);
      endTree_0_nifjp9lau1(b_14);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(s_8);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
      return;
    }
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(s_8);
  }
  if ((mem.u8At(t_14) === 9)) {
    addTree_0_nifjp9lau1(b_14, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1701998846);
      mem.setU32((_o + 4), strlit_0_I8954722698363393223_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
    addIdent_0_nifjp9lau1(b_14, (t_14 + 4));
    emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), false);
    if ((((lo_14 + 1) | 0) < hi_14)) {
      parseExprRange_1_parq39nt2(ps_27, b_14, ((lo_14 + 1) | 0), hi_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)));
    }
    endTree_0_nifjp9lau1(b_14);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
    return;
  }
  if ((mem.u8At(t_14) === 2)) {
    X60Qsc_23: {
      X60Qsc_24: {
        X60Qsc_17: {
          X60Qsc_16: {
            X60Qsc_15: {
              X60Qsc_14: {
                X60Qsc_13: {
                  X60Qsc_12: {
                    X60Qsc_11: {
                      X60Qsc_10: {
                        var X60Qtc_9 = allocFixed(8);
                        mem.copy(X60Qtc_9, (t_14 + 4), 8);
                        var X60Qtc_18 = nimStrAtLe_0_sysvq0asl(X60Qtc_9, 0, 105);
                        if (X60Qtc_18) {
                          var X60Qtc_19 = nimStrAtLe_0_sysvq0asl(X60Qtc_9, 0, 99);
                          if (X60Qtc_19) {
                            if (equalStrings_0_sysvq0asl(X60Qtc_9, (() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 1935762430);
                              mem.setU32((_o + 4), strlit_0_I13909093427330098489_parq39nt2);
                              return _o;
                            })())) {
                              break X60Qsc_12;
                            } else if (equalStrings_0_sysvq0asl(X60Qtc_9, (() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 1684300286);
                              mem.setU32((_o + 4), strlit_0_I9557201018976274010_parq39nt2);
                              return _o;
                            })())) {
                              break X60Qsc_17;
                            }
                          } else {
                            var X60Qtc_20 = nimStrAtLe_0_sysvq0asl(X60Qtc_9, 0, 102);
                            if (X60Qtc_20) {
                              if (equalStrings_0_sysvq0asl(X60Qtc_9, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1853187838);
                                mem.setU32((_o + 4), strlit_0_I9991102891510134496_parq39nt2);
                                return _o;
                              })())) {
                                break X60Qsc_16;
                              }
                            } else {
                              if (equalStrings_0_sysvq0asl(X60Qtc_9, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 6711554);
                                mem.setU32((_o + 4), 0);
                                return _o;
                              })())) {
                                break X60Qsc_13;
                              } else if (equalStrings_0_sysvq0asl(X60Qtc_9, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1702128126);
                                mem.setU32((_o + 4), strlit_0_I9071657656589967445_parq39nt2);
                                return _o;
                              })())) {
                                break X60Qsc_16;
                              }
                            }
                          }
                        } else {
                          var X60Qtc_21 = nimStrAtLe_0_sysvq0asl(X60Qtc_9, 0, 110);
                          if (X60Qtc_21) {
                            if (equalStrings_0_sysvq0asl(X60Qtc_9, (() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 1818848771);
                              mem.setU32((_o + 4), 0);
                              return _o;
                            })())) {
                              break X60Qsc_10;
                            } else if (equalStrings_0_sysvq0asl(X60Qtc_9, (() => {
                              var _o = allocFixed(8);
                              mem.setU32(_o, 1953459715);
                              mem.setU32((_o + 4), 0);
                              return _o;
                            })())) {
                              break X60Qsc_11;
                            }
                          } else {
                            var X60Qtc_22 = nimStrAtLe_0_sysvq0asl(X60Qtc_9, 0, 116);
                            if (X60Qtc_22) {
                              if (equalStrings_0_sysvq0asl(X60Qtc_9, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 2037543939);
                                mem.setU32((_o + 4), 0);
                                return _o;
                              })())) {
                                break X60Qsc_15;
                              } else if (equalStrings_0_sysvq0asl(X60Qtc_9, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1869771006);
                                mem.setU32((_o + 4), strlit_0_I5316556160589403975_parq39nt2);
                                return _o;
                              })())) {
                                break X60Qsc_16;
                              }
                            } else {
                              if (equalStrings_0_sysvq0asl(X60Qtc_9, (() => {
                                var _o = allocFixed(8);
                                mem.setU32(_o, 1701345278);
                                mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
                                return _o;
                              })())) {
                                break X60Qsc_14;
                              }
                            }
                          }
                        }
                        break X60Qsc_24;
                      }
                      addTree_0_nifjp9lau1(b_14, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 1818848771);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                      emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
                      endTree_0_nifjp9lau1(b_14);
                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
                      return;
                      break X60Qsc_23;
                    }
                    addTree_0_nifjp9lau1(b_14, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1701998846);
                      mem.setU32((_o + 4), strlit_0_I8954722698363393223_parq39nt2);
                      return _o;
                    })());
                    emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
                    addIdent_0_nifjp9lau1(b_14, (t_14 + 4));
                    emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), false);
                    if ((((lo_14 + 1) | 0) < hi_14)) {
                      parseExprRange_1_parq39nt2(ps_27, b_14, ((lo_14 + 1) | 0), hi_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)));
                    }
                    endTree_0_nifjp9lau1(b_14);
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
                    return;
                    break X60Qsc_23;
                  }
                  var X60Qx_55;
                  if ((((lo_14 + 1) | 0) < hi_14)) {
                    var X60Qtmp_14 = allocFixed(72);
                    mem.copy(X60Qtmp_14, tok_0_parq39nt2(ps_27, ((lo_14 + 1) | 0)), 72);
                    X60Qx_55 = (mem.u8At(X60Qtmp_14) === 12);
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_14);
                  } else {
                    X60Qx_55 = false;
                  }
                  if (X60Qx_55) {
                    var rb_1 = matchClose_0_parq39nt2(ps_27, ((lo_14 + 1) | 0));
                    var castEnd_0 = rb_1;
                    var X60Qx_56;
                    if ((((rb_1 + 1) | 0) < hi_14)) {
                      var X60Qtmp_15 = allocFixed(72);
                      mem.copy(X60Qtmp_15, tok_0_parq39nt2(ps_27, ((rb_1 + 1) | 0)), 72);
                      X60Qx_56 = (mem.u8At(X60Qtmp_15) === 10);
                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_15);
                    } else {
                      X60Qx_56 = false;
                    }
                    if (X60Qx_56) {
                      var X60Qx_276 = matchClose_0_parq39nt2(ps_27, ((rb_1 + 1) | 0));
                      castEnd_0 = X60Qx_276;
                    }
                    if ((hi_14 <= ((castEnd_0 + 1) | 0))) {
                      parseCastExpr_0_parq39nt2(ps_27, b_14, lo_14, hi_14, pl_14, pc_14);
                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
                      return;
                    }
                  }
                  break X60Qsc_23;
                }
                parseIfExpr_0_parq39nt2(ps_27, b_14, lo_14, hi_14, pl_14, pc_14, false, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 6711554);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
                return;
                break X60Qsc_23;
              }
              parseIfExpr_0_parq39nt2(ps_27, b_14, lo_14, hi_14, pl_14, pc_14, false, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1701345278);
                mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
                return _o;
              })());
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
              return;
              break X60Qsc_23;
            }
            var X60Qx_277 = parseTry_1_parq39nt2(ps_27, b_14, lo_14, pl_14, pc_14);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
            return;
            break X60Qsc_23;
          }
          var X60Qx_278 = parseRoutine_1_parq39nt2(ps_27, b_14, lo_14, pl_14, pc_14, (t_14 + 4));
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
          return;
          break X60Qsc_23;
        }
        var nxt_3 = allocFixed(72);
        mem.copy(nxt_3, tok_0_parq39nt2(ps_27, ((lo_14 + 1) | 0)), 72);
        var X60Qx_279;
        var X60Qx_280;
        if ((mem.u8At(nxt_3) === 10)) {
          X60Qx_280 = (mem.i32((nxt_3 + 40)) === mem.i32((t_14 + 40)));
        } else {
          X60Qx_280 = false;
        }
        if (X60Qx_280) {
          var X60Qx_281 = len_4_sysvq0asl((t_14 + 4));
          X60Qx_279 = (mem.i32((nxt_3 + 44)) === ((mem.i32((t_14 + 44)) + X60Qx_281) | 0));
        } else {
          X60Qx_279 = false;
        }
        var adjacentCall_0 = X60Qx_279;
        var X60Qx_282;
        if ((((lo_14 + 1) | 0) < hi_14)) {
          X60Qx_282 = (!adjacentCall_0);
        } else {
          X60Qx_282 = false;
        }
        if (X60Qx_282) {
          parseCmdKw_0_parq39nt2(ps_27, b_14, lo_14, hi_14, pl_14, pc_14);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nxt_3);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
          return;
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nxt_3);
        break X60Qsc_23;
      }
    }
  }
  var pkind_0 = allocFixed(4);
  mem.setI32(pkind_0, 0);
  var k_6 = findPostfix_0_parq39nt2(ps_27, lo_14, hi_14, pkind_0);
  if ((0 <= k_6)) {
    var opTok_0 = allocFixed(72);
    mem.copy(opTok_0, tok_0_parq39nt2(ps_27, k_6), 72);
    switch (mem.i32(pkind_0)) {
      case 1:
        {
          addTree_0_nifjp9lau1(b_14, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1953457155);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)), pl_14, pc_14, false);
          parsePrimaryRange_0_parq39nt2(ps_27, b_14, lo_14, k_6, mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)));
          var r_0 = allocFixed(72);
          mem.copy(r_0, tok_0_parq39nt2(ps_27, ((k_6 + 1) | 0)), 72);
          addIdent_0_nifjp9lau1(b_14, (r_0 + 4));
          emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((r_0 + 40)), mem.i32((r_0 + 44)), mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)), false);
          endTree_0_nifjp9lau1(b_14);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(r_0);
        }
        break;
      case 2:
        {
          var rp_1 = matchClose_0_parq39nt2(ps_27, k_6);
          addTree_0_nifjp9lau1(b_14, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 7627010);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)), pl_14, pc_14, false);
          parsePrimaryRange_0_parq39nt2(ps_27, b_14, lo_14, k_6, mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)));
          parseArgList_0_parq39nt2(ps_27, b_14, ((k_6 + 1) | 0), rp_1, mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)));
          endTree_0_nifjp9lau1(b_14);
        }
        break;
      case 3:
        {
          var rp_2 = matchClose_0_parq39nt2(ps_27, k_6);
          addTree_0_nifjp9lau1(b_14, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1920295934);
            mem.setU32((_o + 4), strlit_0_I14293528690183020870_parq39nt2);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)), pl_14, pc_14, false);
          parsePrimaryRange_0_parq39nt2(ps_27, b_14, lo_14, k_6, mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)));
          parseArgList_0_parq39nt2(ps_27, b_14, ((k_6 + 1) | 0), rp_2, mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)));
          endTree_0_nifjp9lau1(b_14);
        }
        break;
      default:
        {
          var rp_3 = matchClose_0_parq39nt2(ps_27, k_6);
          var starts_1 = allocFixed(8);
          mem.copy(starts_1, splitArgs_0_parq39nt2(ps_27, ((k_6 + 1) | 0), rp_3), 8);
          var isObj_0 = false;
          if ((0 < mem.i32(starts_1))) {
            var X60Qx_11;
            if ((1 < mem.i32(starts_1))) {
              var X60Qx_283 = getQ_7_Ir8kccm_parq39nt2(starts_1, 1);
              X60Qx_11 = ((mem.i32(X60Qx_283) - 1) | 0);
            } else {
              X60Qx_11 = rp_3;
            }
            var a0Hi_0 = X60Qx_11;
            var X60Qx_57;
            var X60Qx_284 = getQ_7_Ir8kccm_parq39nt2(starts_1, 0);
            var X60Qtmp_16 = allocFixed(72);
            mem.copy(X60Qtmp_16, tok_0_parq39nt2(ps_27, mem.i32(X60Qx_284)), 72);
            if ((mem.u8At(X60Qtmp_16) === 1)) {
              var X60Qx_285 = getQ_7_Ir8kccm_parq39nt2(starts_1, 0);
              var X60Qx_286 = depth0Colon_0_parq39nt2(ps_27, mem.i32(X60Qx_285), a0Hi_0);
              X60Qx_57 = (0 <= X60Qx_286);
            } else {
              X60Qx_57 = false;
            }
            isObj_0 = X60Qx_57;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_16);
          }
          var X60Qx_12 = allocFixed(8);
          nimStrWasMoved(X60Qx_12);
          if (isObj_0) {
            nimStrDestroy(X60Qx_12);
            mem.copy(X60Qx_12, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1868787710);
              mem.setU32((_o + 4), strlit_0_I7084116572891045059_parq39nt2);
              return _o;
            })(), 8);
          } else {
            nimStrDestroy(X60Qx_12);
            mem.copy(X60Qx_12, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1818321918);
              mem.setU32((_o + 4), strlit_0_I1707222714195181991_parq39nt2);
              return _o;
            })(), 8);
          }
          addTree_0_nifjp9lau1(b_14, X60Qx_12);
          emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)), pl_14, pc_14, false);
          parsePrimaryRange_0_parq39nt2(ps_27, b_14, lo_14, k_6, mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)));
          parseArgList_0_parq39nt2(ps_27, b_14, ((k_6 + 1) | 0), rp_3, mem.i32((opTok_0 + 40)), mem.i32((opTok_0 + 44)));
          endTree_0_nifjp9lau1(b_14);
          nimStrDestroy(X60Qx_12);
          eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_1);
        }
        break;
    }
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(opTok_0);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
    return;
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(opTok_0);
  }
  switch (mem.u8At(t_14)) {
    case 3:
      {
        var suf_1 = allocFixed(8);
        mem.copy(suf_1, (t_14 + 32), 8);
        nimStrWasMoved((t_14 + 32));
        var X60Qx_287 = len_4_sysvq0asl(suf_1);
        if ((X60Qx_287 === 0)) {
          var X60Qx_288;
          if ((2147483647n < mem.i64b((t_14 + 16)))) {
            X60Qx_288 = true;
          } else {
            X60Qx_288 = (mem.i64b((t_14 + 16)) < -2147483648n);
          }
          if (X60Qx_288) {
            addTree_0_nifjp9lau1(b_14, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1718973187);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
            addIntLit_0_nifjp9lau1(b_14, mem.i64b((t_14 + 16)));
            addStrLit_0_nifjp9lau1(b_14, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 875981059);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            endTree_0_nifjp9lau1(b_14);
          } else {
            addIntLit_0_nifjp9lau1(b_14, mem.i64b((t_14 + 16)));
            emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
          }
        } else {
          var X60Qx_289 = eqQ_20_sysvq0asl(suf_1, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 29953);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          if (X60Qx_289) {
            addUIntLit_0_nifjp9lau1(b_14, BigInt.asUintN(64, mem.i64b((t_14 + 16))));
            emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
          } else {
            addTree_0_nifjp9lau1(b_14, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1718973187);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
            var X60Qx_290 = getQ_9_sysvq0asl(suf_1, 0);
            if ((X60Qx_290 === 117)) {
              addUIntLit_0_nifjp9lau1(b_14, BigInt.asUintN(64, mem.i64b((t_14 + 16))));
            } else {
              addIntLit_0_nifjp9lau1(b_14, mem.i64b((t_14 + 16)));
            }
            addStrLit_0_nifjp9lau1(b_14, suf_1);
            endTree_0_nifjp9lau1(b_14);
          }
        }
        nimStrDestroy(suf_1);
      }
      break;
    case 4:
      {
        var X60Qx_291 = len_4_sysvq0asl((t_14 + 32));
        if ((X60Qx_291 === 0)) {
          addFloatLit_0_nifjp9lau1(b_14, mem.f64((t_14 + 24)), ((mem.i32((t_14 + 44)) - pc_14) | 0), ((mem.i32((t_14 + 40)) - pl_14) | 0), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 0);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
        } else {
          addTree_0_nifjp9lau1(b_14, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1718973187);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
          addFloatLit_0_nifjp9lau1(b_14, mem.f64((t_14 + 24)), 0, 0, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 0);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          addStrLit_0_nifjp9lau1(b_14, (t_14 + 32));
          endTree_0_nifjp9lau1(b_14);
        }
      }
      break;
    case 5:
      {
        addStrLit_0_nifjp9lau1(b_14, (t_14 + 4));
        emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
      }
      break;
    case 6:
      {
        addStrLit_1_nifjp9lau1(b_14, (t_14 + 4), (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 20993);
          mem.setU32((_o + 4), 0);
          return _o;
        })(), ((mem.i32((t_14 + 44)) - pc_14) | 0), ((mem.i32((t_14 + 40)) - pl_14) | 0), (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 0);
          mem.setU32((_o + 4), 0);
          return _o;
        })());
      }
      break;
    case 7:
      {
        addStrLit_1_nifjp9lau1(b_14, (t_14 + 4), (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 21505);
          mem.setU32((_o + 4), 0);
          return _o;
        })(), ((mem.i32((t_14 + 44)) - pc_14) | 0), ((mem.i32((t_14 + 40)) - pl_14) | 0), (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 0);
          mem.setU32((_o + 4), 0);
          return _o;
        })());
      }
      break;
    case 8:
      {
        addCharLit_0_nifjp9lau1(b_14, Number(BigInt.asUintN(8, mem.i64b((t_14 + 16)))));
        emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
      }
      break;
    case 10:
      {
        X60Qlab_0: {
          var rpIdx_0 = matchClose_0_parq39nt2(ps_27, lo_14);
          var semis_0 = allocFixed(8);
          mem.copy(semis_0, newSeqUninit_0_Iggfvwp_mat7cnfv21(0), 8);
          {
            whileStmtLabel_1: {
              var d_0 = allocFixed(4);
              mem.setI32(d_0, 0);
              var k_7 = allocFixed(4);
              mem.setI32(k_7, ((lo_14 + 1) | 0));
              {
                while ((mem.i32(k_7) < rpIdx_0)) {
                  var kk_0 = allocFixed(72);
                  mem.copy(kk_0, tok_0_parq39nt2(ps_27, mem.i32(k_7)), 72);
                  var X60Qx_292 = isOpenBracket_0_parq39nt2(mem.u8At(kk_0));
                  if (X60Qx_292) {
                    inc_1_I6wjjge_cmdqs323n1(d_0);
                  } else {
                    var X60Qx_293 = isCloseBracket_0_parq39nt2(mem.u8At(kk_0));
                    if (X60Qx_293) {
                      if ((0 < mem.i32(d_0))) {
                        dec_1_I0nzoz91_envto7w6l1(d_0);
                      }
                    } else {
                      var X60Qx_294;
                      if ((mem.i32(d_0) === 0)) {
                        X60Qx_294 = (mem.u8At(kk_0) === 17);
                      } else {
                        X60Qx_294 = false;
                      }
                      if (X60Qx_294) {
                        add_0_I8kd4i4_parq39nt2(semis_0, mem.i32(k_7));
                      }
                    }
                  }
                  inc_1_I6wjjge_cmdqs323n1(k_7);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kk_0);
                }
              }
            }
          }
        }
        var inner_0 = allocFixed(72);
        mem.copy(inner_0, tok_0_parq39nt2(ps_27, ((lo_14 + 1) | 0)), 72);
        var X60Qx_295;
        if ((mem.u8At(inner_0) === 2)) {
          var X60Qx_296;
          var X60Qx_297;
          var X60Qx_298;
          var X60Qx_299;
          var X60Qx_300;
          var X60Qx_301;
          var X60Qx_302 = eqQ_20_sysvq0asl((inner_0 + 4), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 6711554);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          if (X60Qx_302) {
            X60Qx_301 = true;
          } else {
            var X60Qx_303 = eqQ_20_sysvq0asl((inner_0 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 2037543939);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            X60Qx_301 = X60Qx_303;
          }
          if (X60Qx_301) {
            X60Qx_300 = true;
          } else {
            var X60Qx_304 = eqQ_20_sysvq0asl((inner_0 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1701345278);
              mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
              return _o;
            })());
            X60Qx_300 = X60Qx_304;
          }
          if (X60Qx_300) {
            X60Qx_299 = true;
          } else {
            var X60Qx_305 = eqQ_20_sysvq0asl((inner_0 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1935762430);
              mem.setU32((_o + 4), strlit_0_I4956278306908871092_parq39nt2);
              return _o;
            })());
            X60Qx_299 = X60Qx_305;
          }
          if (X60Qx_299) {
            X60Qx_298 = true;
          } else {
            var X60Qx_306 = eqQ_20_sysvq0asl((inner_0 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1869374206);
              mem.setU32((_o + 4), strlit_0_I9830314142150548690_parq39nt2);
              return _o;
            })());
            X60Qx_298 = X60Qx_306;
          }
          if (X60Qx_298) {
            X60Qx_297 = true;
          } else {
            var X60Qx_307 = eqQ_20_sysvq0asl((inner_0 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1768454142);
              mem.setU32((_o + 4), strlit_0_I13200118161122656888_parq39nt2);
              return _o;
            })());
            X60Qx_297 = X60Qx_307;
          }
          if (X60Qx_297) {
            X60Qx_296 = true;
          } else {
            var X60Qx_308 = eqQ_20_sysvq0asl((inner_0 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1919903235);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            X60Qx_296 = X60Qx_308;
          }
          X60Qx_295 = X60Qx_296;
        } else {
          X60Qx_295 = false;
        }
        var ctrl_0 = X60Qx_295;
        var X60Qx_309;
        if ((0 < mem.i32(semis_0))) {
          X60Qx_309 = true;
        } else {
          X60Qx_309 = ctrl_0;
        }
        if (X60Qx_309) {
          forStmtLabel_2: {
            addTree_0_nifjp9lau1(b_14, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1886938622);
              mem.setU32((_o + 4), strlit_0_I13798915436014509391_parq39nt2);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
            addTree_0_nifjp9lau1(b_14, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1836348414);
              mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((inner_0 + 40)), mem.i32((inner_0 + 44)), mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), false);
            var segLo_0 = ((lo_14 + 1) | 0);
            {
              whileStmtLabel_3: {
                var X60Qlf_7 = 0;
                var X60Qlf_8 = len_3_I0v1j8d_parq39nt2(semis_0);
                var X60Qlf_9 = allocFixed(4);
                mem.setI32(X60Qlf_9, X60Qlf_7);
                {
                  while ((mem.i32(X60Qlf_9) < X60Qlf_8)) {
                    {
                      var X60Qx_310 = getQ_7_Ir8kccm_parq39nt2(semis_0, mem.i32(X60Qlf_9));
                      var X60Qx_311 = parseStmt_1_parq39nt2(ps_27, b_14, segLo_0, mem.i32((inner_0 + 40)), mem.i32((inner_0 + 44)), mem.i32(X60Qx_310));
                      var X60Qx_312 = getQ_7_Ir8kccm_parq39nt2(semis_0, mem.i32(X60Qlf_9));
                      segLo_0 = ((mem.i32(X60Qx_312) + 1) | 0);
                    }
                    inc_1_I6wjjge_cmdqs323n1(X60Qlf_9);
                  }
                }
              }
            }
          }
          endTree_0_nifjp9lau1(b_14);
          var rt_0 = allocFixed(72);
          mem.copy(rt_0, tok_0_parq39nt2(ps_27, segLo_0), 72);
          var X60Qx_313;
          if ((mem.u8At(rt_0) === 2)) {
            var X60Qx_314 = eqQ_20_sysvq0asl((rt_0 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 2037543939);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            X60Qx_313 = X60Qx_314;
          } else {
            X60Qx_313 = false;
          }
          if (X60Qx_313) {
            parseTryExpr_1_parq39nt2(ps_27, b_14, segLo_0, rpIdx_0, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)));
          } else {
            var X60Qx_315;
            if ((mem.u8At(rt_0) === 2)) {
              var X60Qx_316 = eqQ_20_sysvq0asl((rt_0 + 4), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 6711554);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              X60Qx_315 = X60Qx_316;
            } else {
              X60Qx_315 = false;
            }
            if (X60Qx_315) {
              parseIfExpr_0_parq39nt2(ps_27, b_14, segLo_0, rpIdx_0, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), true, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 6711554);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
            } else {
              parseExprRange_1_parq39nt2(ps_27, b_14, segLo_0, rpIdx_0, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)));
            }
          }
          endTree_0_nifjp9lau1(b_14);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(rt_0);
        } else {
          var starts_2 = allocFixed(8);
          mem.copy(starts_2, splitArgs_0_parq39nt2(ps_27, ((lo_14 + 1) | 0), rpIdx_0), 8);
          var X60Qx_13 = allocFixed(8);
          nimStrWasMoved(X60Qx_13);
          if ((1 < mem.i32(starts_2))) {
            nimStrDestroy(X60Qx_13);
            mem.copy(X60Qx_13, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1886745603);
              mem.setU32((_o + 4), 0);
              return _o;
            })(), 8);
          } else {
            nimStrDestroy(X60Qx_13);
            mem.copy(X60Qx_13, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1918988291);
              mem.setU32((_o + 4), 0);
              return _o;
            })(), 8);
          }
          var tag_9 = allocFixed(8);
          mem.copy(tag_9, X60Qx_13, 8);
          nimStrWasMoved(X60Qx_13);
          addTree_0_nifjp9lau1(b_14, tag_9);
          emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
          parseArgList_0_parq39nt2(ps_27, b_14, ((lo_14 + 1) | 0), rpIdx_0, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)));
          endTree_0_nifjp9lau1(b_14);
          nimStrDestroy(tag_9);
          nimStrDestroy(X60Qx_13);
          eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_2);
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(inner_0);
        eQdestroy_1_Iv9ij5i1_mat7cnfv21(semis_0);
      }
      break;
    case 12:
      {
        var rpIdx_1 = matchClose_0_parq39nt2(ps_27, lo_14);
        addTree_0_nifjp9lau1(b_14, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1634886398);
          mem.setU32((_o + 4), strlit_0_I14055597598996035090_parq39nt2);
          return _o;
        })());
        emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
        parseArgList_0_parq39nt2(ps_27, b_14, ((lo_14 + 1) | 0), rpIdx_1, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)));
        endTree_0_nifjp9lau1(b_14);
      }
      break;
    case 14:
      {
        var rpIdx_2 = matchClose_0_parq39nt2(ps_27, lo_14);
        var X60Qx_317 = depth0Colon_0_parq39nt2(ps_27, ((lo_14 + 1) | 0), rpIdx_2);
        var isTab_0 = (0 <= X60Qx_317);
        var X60Qx_14 = allocFixed(8);
        nimStrWasMoved(X60Qx_14);
        if (isTab_0) {
          nimStrDestroy(X60Qx_14);
          mem.copy(X60Qx_14, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1650554110);
            mem.setU32((_o + 4), strlit_0_I16361658452647583931_parq39nt2);
            return _o;
          })(), 8);
        } else {
          nimStrDestroy(X60Qx_14);
          mem.copy(X60Qx_14, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1920295934);
            mem.setU32((_o + 4), strlit_0_I10209608037894561257_parq39nt2);
            return _o;
          })(), 8);
        }
        addTree_0_nifjp9lau1(b_14, X60Qx_14);
        emitInfo_0_parq39nt2(ps_27, b_14, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)), pl_14, pc_14, false);
        parseArgList_0_parq39nt2(ps_27, b_14, ((lo_14 + 1) | 0), rpIdx_2, mem.i32((t_14 + 40)), mem.i32((t_14 + 44)));
        endTree_0_nifjp9lau1(b_14);
        nimStrDestroy(X60Qx_14);
      }
      break;
    case 1:
    case 2:
      {
        emitName_0_parq39nt2(ps_27, b_14, t_14, pl_14, pc_14);
      }
      break;
    default:
      {
        addEmpty_0_nifjp9lau1(b_14, 1);
      }
      break;
  }
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_14);
}

function parseExprRange_1_parq39nt2(ps_28, b_15, lo_15, hi_15, pl_15, pc_15) {
  let head_1 = allocFixed(72);
  mem.copy(head_1, tok_0_parq39nt2(ps_28, lo_15), 72);
  let X60Qx_318;
  if ((mem.u8At(head_1) === 2)) {
    let X60Qx_319;
    let X60Qx_320;
    let X60Qx_321;
    let X60Qx_322;
    let X60Qx_323;
    let X60Qx_324 = eqQ_20_sysvq0asl((head_1 + 4), (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 6711554);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    if (X60Qx_324) {
      X60Qx_323 = true;
    } else {
      let X60Qx_325 = eqQ_20_sysvq0asl((head_1 + 4), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1701345278);
        mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
        return _o;
      })());
      X60Qx_323 = X60Qx_325;
    }
    if (X60Qx_323) {
      X60Qx_322 = true;
    } else {
      let X60Qx_326 = eqQ_20_sysvq0asl((head_1 + 4), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 2037543939);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      X60Qx_322 = X60Qx_326;
    }
    if (X60Qx_322) {
      X60Qx_321 = true;
    } else {
      let X60Qx_327 = eqQ_20_sysvq0asl((head_1 + 4), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1869771006);
        mem.setU32((_o + 4), strlit_0_I5316556160589403975_parq39nt2);
        return _o;
      })());
      X60Qx_321 = X60Qx_327;
    }
    if (X60Qx_321) {
      X60Qx_320 = true;
    } else {
      let X60Qx_328 = eqQ_20_sysvq0asl((head_1 + 4), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1853187838);
        mem.setU32((_o + 4), strlit_0_I9991102891510134496_parq39nt2);
        return _o;
      })());
      X60Qx_320 = X60Qx_328;
    }
    if (X60Qx_320) {
      X60Qx_319 = true;
    } else {
      let X60Qx_329 = eqQ_20_sysvq0asl((head_1 + 4), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1702128126);
        mem.setU32((_o + 4), strlit_0_I9071657656589967445_parq39nt2);
        return _o;
      })());
      X60Qx_319 = X60Qx_329;
    }
    X60Qx_318 = X60Qx_319;
  } else {
    X60Qx_318 = false;
  }
  if (X60Qx_318) {
    parsePrimaryRange_0_parq39nt2(ps_28, b_15, lo_15, hi_15, pl_15, pc_15);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(head_1);
    return;
  }
  let split_0 = findSplit_0_parq39nt2(ps_28, lo_15, hi_15);
  if ((split_0 < 0)) {
    let ce_0 = cmdCalleeEnd_0_parq39nt2(ps_28, lo_15, hi_15);
    let X60Qx_330;
    let X60Qx_331;
    if ((mem.u8At(head_1) === 1)) {
      X60Qx_331 = (ce_0 < hi_15);
    } else {
      X60Qx_331 = false;
    }
    if (X60Qx_331) {
      let X60Qx_332 = startsArg_0_parq39nt2(ps_28, ce_0, hi_15);
      X60Qx_330 = X60Qx_332;
    } else {
      X60Qx_330 = false;
    }
    if (X60Qx_330) {
      let callee_0 = allocFixed(72);
      mem.copy(callee_0, tok_0_parq39nt2(ps_28, lo_15), 72);
      addTree_0_nifjp9lau1(b_15, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1684890371);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_28, b_15, mem.i32((callee_0 + 40)), mem.i32((callee_0 + 44)), pl_15, pc_15, false);
      parseExprRange_1_parq39nt2(ps_28, b_15, lo_15, ce_0, mem.i32((callee_0 + 40)), mem.i32((callee_0 + 44)));
      parseArgList_0_parq39nt2(ps_28, b_15, ce_0, hi_15, mem.i32((callee_0 + 40)), mem.i32((callee_0 + 44)));
      endTree_0_nifjp9lau1(b_15);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(callee_0);
    } else {
      parsePrimaryRange_0_parq39nt2(ps_28, b_15, lo_15, hi_15, pl_15, pc_15);
    }
  } else {
    let op_2 = allocFixed(72);
    mem.copy(op_2, tok_0_parq39nt2(ps_28, split_0), 72);
    addTree_0_nifjp9lau1(b_15, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1718512126);
      mem.setU32((_o + 4), strlit_0_I8390060478375454995_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_28, b_15, mem.i32((op_2 + 40)), mem.i32((op_2 + 44)), pl_15, pc_15, false);
    addIdent_0_nifjp9lau1(b_15, (op_2 + 4));
    emitInfo_0_parq39nt2(ps_28, b_15, mem.i32((op_2 + 40)), mem.i32((op_2 + 44)), mem.i32((op_2 + 40)), mem.i32((op_2 + 44)), false);
    parseExprRange_1_parq39nt2(ps_28, b_15, lo_15, split_0, mem.i32((op_2 + 40)), mem.i32((op_2 + 44)));
    parseExprRange_1_parq39nt2(ps_28, b_15, ((split_0 + 1) | 0), hi_15, mem.i32((op_2 + 40)), mem.i32((op_2 + 44)));
    endTree_0_nifjp9lau1(b_15);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(op_2);
  }
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(head_1);
}

function isPrefixTypeKw_0_parq39nt2(s_0) {
  let result_20;
  let X60Qx_333;
  let X60Qx_334;
  let X60Qx_335;
  let X60Qx_336;
  let X60Qx_337 = eqQ_20_sysvq0asl(s_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1717924355);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  if (X60Qx_337) {
    X60Qx_336 = true;
  } else {
    let X60Qx_338 = eqQ_20_sysvq0asl(s_0, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1920233475);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    X60Qx_336 = X60Qx_338;
  }
  if (X60Qx_336) {
    X60Qx_335 = true;
  } else {
    let X60Qx_339 = eqQ_20_sysvq0asl(s_0, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1918989827);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    X60Qx_335 = X60Qx_339;
  }
  if (X60Qx_335) {
    X60Qx_334 = true;
  } else {
    let X60Qx_340 = eqQ_20_sysvq0asl(s_0, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1953853187);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    X60Qx_334 = X60Qx_340;
  }
  if (X60Qx_334) {
    X60Qx_333 = true;
  } else {
    let X60Qx_341 = eqQ_20_sysvq0asl(s_0, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1936286974);
      mem.setU32((_o + 4), strlit_0_I3021806080610957510_parq39nt2);
      return _o;
    })());
    X60Qx_333 = X60Qx_341;
  }
  result_20 = X60Qx_333;
  return result_20;
}

function prefixTypeTag_0_parq39nt2(s_1) {
  let result_21 = allocFixed(8);
  nimStrWasMoved(result_21);
  let X60Qx_15 = allocFixed(8);
  nimStrWasMoved(X60Qx_15);
  let X60Qx_342 = eqQ_20_sysvq0asl(s_1, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1918989827);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  if (X60Qx_342) {
    nimStrDestroy(X60Qx_15);
    mem.copy(X60Qx_15, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1953852675);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    nimStrDestroy(X60Qx_15);
    let X60Qx_343 = allocFixed(8);
    mem.copy(X60Qx_343, nimStrDup(s_1), 8);
    mem.copy(X60Qx_15, X60Qx_343, 8);
  }
  nimStrDestroy(result_21);
  mem.copy(result_21, X60Qx_15, 8);
  nimStrWasMoved(X60Qx_15);
  nimStrDestroy(X60Qx_15);
  return result_21;
  nimStrDestroy(X60Qx_15);
  return result_21;
}

function typeExprEnd_0_parq39nt2(ps_38, lo_19) {
  whileStmtLabel_0: {
    var result_22;
    var depth_9 = allocFixed(4);
    mem.setI32(depth_9, 0);
    var i_17 = allocFixed(4);
    mem.setI32(i_17, lo_19);
    var X60Qtmp_17 = allocFixed(72);
    mem.copy(X60Qtmp_17, tok_0_parq39nt2(ps_38, lo_19), 72);
    var startLine_0 = mem.i32((X60Qtmp_17 + 40));
    {
      while (true) {
        var X60Qtmp_18 = allocFixed(72);
        mem.copy(X60Qtmp_18, tok_0_parq39nt2(ps_38, mem.i32(i_17)), 72);
        if ((!(mem.u8At(X60Qtmp_18) === 0))) {
          var t_15 = allocFixed(72);
          mem.copy(t_15, tok_0_parq39nt2(ps_38, mem.i32(i_17)), 72);
          var X60Qx_344;
          if ((mem.i32(depth_9) === 0)) {
            X60Qx_344 = (mem.u8At(t_15) === 14);
          } else {
            X60Qx_344 = false;
          }
          if (X60Qx_344) {
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_15);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_18);
            break whileStmtLabel_0;
          } else {
            var X60Qx_345 = isOpenBracket_0_parq39nt2(mem.u8At(t_15));
            if (X60Qx_345) {
              inc_1_I6wjjge_cmdqs323n1(depth_9);
            } else {
              var X60Qx_346 = isCloseBracket_0_parq39nt2(mem.u8At(t_15));
              if (X60Qx_346) {
                if ((mem.i32(depth_9) === 0)) {
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_15);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_18);
                  break whileStmtLabel_0;
                }
                dec_1_I0nzoz91_envto7w6l1(depth_9);
              } else {
                if ((mem.i32(depth_9) === 0)) {
                  var X60Qx_347;
                  var X60Qx_348;
                  if ((mem.u8At(t_15) === 16)) {
                    X60Qx_348 = true;
                  } else {
                    X60Qx_348 = (mem.u8At(t_15) === 17);
                  }
                  if (X60Qx_348) {
                    X60Qx_347 = true;
                  } else {
                    X60Qx_347 = (mem.u8At(t_15) === 18);
                  }
                  if (X60Qx_347) {
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_15);
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_18);
                    break whileStmtLabel_0;
                  } else {
                    var X60Qx_349;
                    if ((mem.u8At(t_15) === 9)) {
                      var X60Qx_350 = eqQ_20_sysvq0asl((t_15 + 4), (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 15617);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                      X60Qx_349 = X60Qx_350;
                    } else {
                      X60Qx_349 = false;
                    }
                    if (X60Qx_349) {
                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_15);
                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_18);
                      break whileStmtLabel_0;
                    } else {
                      var X60Qx_351;
                      if ((!(mem.i32((t_15 + 40)) === startLine_0))) {
                        X60Qx_351 = (0 <= mem.i32((t_15 + 52)));
                      } else {
                        X60Qx_351 = false;
                      }
                      if (X60Qx_351) {
                        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_15);
                        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_18);
                        break whileStmtLabel_0;
                      }
                    }
                  }
                }
              }
            }
          }
          inc_1_I6wjjge_cmdqs323n1(i_17);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_15);
        } else {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_18);
          break;
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_18);
      }
    }
  }
  result_22 = mem.i32(i_17);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_17);
  return result_22;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_17);
  return result_22;
}

function parseTypeRange_1_parq39nt2(ps_39, b_25, lo_20, hi_19, pl_25, pc_25) {
  X60Qlab_13: {
    dotCase_0: {
      if ((hi_19 <= lo_20)) {
        addEmpty_0_nifjp9lau1(b_25, 1);
        return;
      }
      var first_0 = allocFixed(72);
      mem.copy(first_0, tok_0_parq39nt2(ps_39, lo_20), 72);
      var X60Qx_352;
      if ((mem.u8At(first_0) === 2)) {
        var X60Qx_353 = isPrefixTypeKw_0_parq39nt2((first_0 + 4));
        X60Qx_352 = X60Qx_353;
      } else {
        X60Qx_352 = false;
      }
      if (X60Qx_352) {
        var X60Qtmp_19 = allocFixed(8);
        mem.copy(X60Qtmp_19, prefixTypeTag_0_parq39nt2((first_0 + 4)), 8);
        addTree_0_nifjp9lau1(b_25, X60Qtmp_19);
        emitInfo_0_parq39nt2(ps_39, b_25, mem.i32((first_0 + 40)), mem.i32((first_0 + 44)), pl_25, pc_25, false);
        parseTypeRange_1_parq39nt2(ps_39, b_25, ((lo_20 + 1) | 0), hi_19, mem.i32((first_0 + 40)), mem.i32((first_0 + 44)));
        endTree_0_nifjp9lau1(b_25);
        nimStrDestroy(X60Qtmp_19);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_0);
        return;
        nimStrDestroy(X60Qtmp_19);
      }
      var X60Qx_354;
      if ((mem.u8At(first_0) === 2)) {
        var X60Qx_355;
        var X60Qx_356 = eqQ_20_sysvq0asl((first_0 + 4), (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1869771006);
          mem.setU32((_o + 4), strlit_0_I5316556160589403975_parq39nt2);
          return _o;
        })());
        if (X60Qx_356) {
          X60Qx_355 = true;
        } else {
          var X60Qx_357 = eqQ_20_sysvq0asl((first_0 + 4), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1702128126);
            mem.setU32((_o + 4), strlit_0_I9071657656589967445_parq39nt2);
            return _o;
          })());
          X60Qx_355 = X60Qx_357;
        }
        X60Qx_354 = X60Qx_355;
      } else {
        X60Qx_354 = false;
      }
      if (X60Qx_354) {
        parseProcType_1_parq39nt2(ps_39, b_25, lo_20, hi_19, pl_25, pc_25);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_0);
        return;
      }
      var X60Qx_358;
      if ((mem.u8At(first_0) === 2)) {
        var X60Qx_359 = eqQ_20_sysvq0asl((first_0 + 4), (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1886745854);
          mem.setU32((_o + 4), strlit_0_I18086024188298164462_parq39nt2);
          return _o;
        })());
        X60Qx_358 = X60Qx_359;
      } else {
        X60Qx_358 = false;
      }
      if (X60Qx_358) {
        parseTupleInline_1_parq39nt2(ps_39, b_25, lo_20, hi_19, pl_25, pc_25);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_0);
        return;
      }
      var X60Qx_360;
      if ((mem.u8At(first_0) === 10)) {
        var X60Qx_361 = matchClose_0_parq39nt2(ps_39, lo_20);
        X60Qx_360 = (X60Qx_361 === ((hi_19 - 1) | 0));
      } else {
        X60Qx_360 = false;
      }
      if (X60Qx_360) {
        forStmtLabel_0: {
          var rb_2 = ((hi_19 - 1) | 0);
          addTree_0_nifjp9lau1(b_25, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1886745603);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_39, b_25, mem.i32((first_0 + 40)), mem.i32((first_0 + 44)), pl_25, pc_25, false);
          var elems_0 = allocFixed(8);
          mem.copy(elems_0, splitArgs_0_parq39nt2(ps_39, ((lo_20 + 1) | 0), rb_2), 8);
          {
            whileStmtLabel_1: {
              var X60Qlf_10 = 0;
              var X60Qlf_11 = len_3_I0v1j8d_parq39nt2(elems_0);
              var X60Qlf_12 = allocFixed(4);
              mem.setI32(X60Qlf_12, X60Qlf_10);
              {
                while ((mem.i32(X60Qlf_12) < X60Qlf_11)) {
                  {
                    continueLabel_2: {
                      {
                        var X60Qx_362 = getQ_7_Ir8kccm_parq39nt2(elems_0, mem.i32(X60Qlf_12));
                        var X60Qii_3 = allocFixed(4);
                        mem.setI32(X60Qii_3, mem.i32(X60Qx_362));
                        var X60Qx_16;
                        var X60Qx_363 = len_3_I0v1j8d_parq39nt2(elems_0);
                        if ((((mem.i32(X60Qlf_12) + 1) | 0) < X60Qx_363)) {
                          var X60Qx_364 = getQ_7_Ir8kccm_parq39nt2(elems_0, ((mem.i32(X60Qlf_12) + 1) | 0));
                          X60Qx_16 = ((mem.i32(X60Qx_364) - 1) | 0);
                        } else {
                          X60Qx_16 = rb_2;
                        }
                        var X60Qii_4 = X60Qx_16;
                        if ((X60Qii_4 <= mem.i32(X60Qii_3))) {
                          break continueLabel_2;
                        }
                        var X60Qii_5 = allocFixed(4);
                        mem.setI32(X60Qii_5, depth0Colon_0_parq39nt2(ps_39, mem.i32(X60Qii_3), X60Qii_4));
                        if ((0 <= mem.i32(X60Qii_5))) {
                          var X60Qii_6 = allocFixed(72);
                          mem.copy(X60Qii_6, tok_0_parq39nt2(ps_39, mem.i32(X60Qii_3)), 72);
                          addTree_0_nifjp9lau1(b_25, (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 7760642);
                            mem.setU32((_o + 4), 0);
                            return _o;
                          })());
                          emitInfo_0_parq39nt2(ps_39, b_25, mem.i32((X60Qii_6 + 40)), mem.i32((X60Qii_6 + 44)), mem.i32((first_0 + 40)), mem.i32((first_0 + 44)), false);
                          addIdent_0_nifjp9lau1(b_25, (X60Qii_6 + 4));
                          emitInfo_0_parq39nt2(ps_39, b_25, mem.i32((X60Qii_6 + 40)), mem.i32((X60Qii_6 + 44)), mem.i32((X60Qii_6 + 40)), mem.i32((X60Qii_6 + 44)), false);
                          parseTypeRange_1_parq39nt2(ps_39, b_25, ((mem.i32(X60Qii_5) + 1) | 0), X60Qii_4, mem.i32((X60Qii_6 + 40)), mem.i32((X60Qii_6 + 44)));
                          endTree_0_nifjp9lau1(b_25);
                          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_6);
                        } else {
                          parseTypeRange_1_parq39nt2(ps_39, b_25, mem.i32(X60Qii_3), X60Qii_4, mem.i32((first_0 + 40)), mem.i32((first_0 + 44)));
                        }
                      }
                    }
                  }
                  inc_1_I6wjjge_cmdqs323n1(X60Qlf_12);
                }
              }
            }
          }
        }
        endTree_0_nifjp9lau1(b_25);
        eQdestroy_1_Iv9ij5i1_mat7cnfv21(elems_0);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_0);
        return;
        eQdestroy_1_Iv9ij5i1_mat7cnfv21(elems_0);
      }
      var sp_0 = findSplit_0_parq39nt2(ps_39, lo_20, hi_19);
      if ((0 <= sp_0)) {
        var op_3 = allocFixed(72);
        mem.copy(op_3, tok_0_parq39nt2(ps_39, sp_0), 72);
        addTree_0_nifjp9lau1(b_25, (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1718512126);
          mem.setU32((_o + 4), strlit_0_I8390060478375454995_parq39nt2);
          return _o;
        })());
        emitInfo_0_parq39nt2(ps_39, b_25, mem.i32((op_3 + 40)), mem.i32((op_3 + 44)), pl_25, pc_25, false);
        addIdent_0_nifjp9lau1(b_25, (op_3 + 4));
        emitInfo_0_parq39nt2(ps_39, b_25, mem.i32((op_3 + 40)), mem.i32((op_3 + 44)), mem.i32((op_3 + 40)), mem.i32((op_3 + 44)), false);
        parseTypeRange_1_parq39nt2(ps_39, b_25, lo_20, sp_0, mem.i32((op_3 + 40)), mem.i32((op_3 + 44)));
        parseTypeRange_1_parq39nt2(ps_39, b_25, ((sp_0 + 1) | 0), hi_19, mem.i32((op_3 + 40)), mem.i32((op_3 + 44)));
        endTree_0_nifjp9lau1(b_25);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(op_3);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_0);
        return;
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(op_3);
      }
      var X60Qtmp_20 = allocFixed(72);
      mem.copy(X60Qtmp_20, tok_0_parq39nt2(ps_39, ((hi_19 - 1) | 0)), 72);
      if ((mem.u8At(X60Qtmp_20) === 13)) {
        whileStmtLabel_7: {
          var depth_10 = allocFixed(4);
          mem.setI32(depth_10, 0);
          var k_8 = allocFixed(4);
          mem.setI32(k_8, ((hi_19 - 1) | 0));
          {
            while ((lo_20 <= mem.i32(k_8))) {
              var X60Qtmp_21 = allocFixed(72);
              mem.copy(X60Qtmp_21, tok_0_parq39nt2(ps_39, mem.i32(k_8)), 72);
              var kk_1 = mem.u8At(X60Qtmp_21);
              var X60Qx_365 = isCloseBracket_0_parq39nt2(kk_1);
              if (X60Qx_365) {
                inc_1_I6wjjge_cmdqs323n1(depth_10);
              } else {
                var X60Qx_366 = isOpenBracket_0_parq39nt2(kk_1);
                if (X60Qx_366) {
                  dec_1_I0nzoz91_envto7w6l1(depth_10);
                  if ((mem.i32(depth_10) === 0)) {
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_21);
                    break whileStmtLabel_7;
                  }
                }
              }
              dec_1_I0nzoz91_envto7w6l1(k_8);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_21);
            }
          }
        }
        var X60Qx_58;
        if ((lo_20 < mem.i32(k_8))) {
          var X60Qtmp_22 = allocFixed(72);
          mem.copy(X60Qtmp_22, tok_0_parq39nt2(ps_39, mem.i32(k_8)), 72);
          X60Qx_58 = (mem.u8At(X60Qtmp_22) === 12);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_22);
        } else {
          X60Qx_58 = false;
        }
        if (X60Qx_58) {
          forStmtLabel_8: {
            var lb_1 = allocFixed(72);
            mem.copy(lb_1, tok_0_parq39nt2(ps_39, mem.i32(k_8)), 72);
            addTree_0_nifjp9lau1(b_25, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 7627010);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_39, b_25, mem.i32((lb_1 + 40)), mem.i32((lb_1 + 44)), pl_25, pc_25, false);
            parseTypeRange_1_parq39nt2(ps_39, b_25, lo_20, mem.i32(k_8), mem.i32((lb_1 + 40)), mem.i32((lb_1 + 44)));
            var starts_3 = allocFixed(8);
            mem.copy(starts_3, splitArgs_0_parq39nt2(ps_39, ((mem.i32(k_8) + 1) | 0), ((hi_19 - 1) | 0)), 8);
            {
              whileStmtLabel_9: {
                var X60Qlf_13 = 0;
                var X60Qlf_14 = len_3_I0v1j8d_parq39nt2(starts_3);
                var X60Qlf_15 = allocFixed(4);
                mem.setI32(X60Qlf_15, X60Qlf_13);
                {
                  while ((mem.i32(X60Qlf_15) < X60Qlf_14)) {
                    {
                      var X60Qx_367 = getQ_7_Ir8kccm_parq39nt2(starts_3, mem.i32(X60Qlf_15));
                      var X60Qii_10 = mem.i32(X60Qx_367);
                      var X60Qx_17;
                      var X60Qx_368 = len_3_I0v1j8d_parq39nt2(starts_3);
                      if ((((mem.i32(X60Qlf_15) + 1) | 0) < X60Qx_368)) {
                        var X60Qx_369 = getQ_7_Ir8kccm_parq39nt2(starts_3, ((mem.i32(X60Qlf_15) + 1) | 0));
                        X60Qx_17 = ((mem.i32(X60Qx_369) - 1) | 0);
                      } else {
                        X60Qx_17 = ((hi_19 - 1) | 0);
                      }
                      var X60Qii_11 = X60Qx_17;
                      if ((X60Qii_10 < X60Qii_11)) {
                        parseTypeRange_1_parq39nt2(ps_39, b_25, X60Qii_10, X60Qii_11, mem.i32((lb_1 + 40)), mem.i32((lb_1 + 44)));
                      }
                    }
                    inc_1_I6wjjge_cmdqs323n1(X60Qlf_15);
                  }
                }
              }
            }
          }
          endTree_0_nifjp9lau1(b_25);
          eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_3);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(lb_1);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_20);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_0);
          return;
          eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_3);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(lb_1);
        }
      }
      {
        whileStmtLabel_12: {
          var depth_11 = allocFixed(4);
          mem.setI32(depth_11, 0);
          var d_1 = -1;
          var i_18 = allocFixed(4);
          mem.setI32(i_18, lo_20);
          {
            while ((mem.i32(i_18) < hi_19)) {
              var t_16 = allocFixed(72);
              mem.copy(t_16, tok_0_parq39nt2(ps_39, mem.i32(i_18)), 72);
              var X60Qx_370 = isOpenBracket_0_parq39nt2(mem.u8At(t_16));
              if (X60Qx_370) {
                inc_1_I6wjjge_cmdqs323n1(depth_11);
              } else {
                var X60Qx_371 = isCloseBracket_0_parq39nt2(mem.u8At(t_16));
                if (X60Qx_371) {
                  if ((0 < mem.i32(depth_11))) {
                    dec_1_I0nzoz91_envto7w6l1(depth_11);
                  }
                } else {
                  var X60Qx_372;
                  var X60Qx_373;
                  if ((mem.i32(depth_11) === 0)) {
                    X60Qx_373 = (mem.u8At(t_16) === 19);
                  } else {
                    X60Qx_373 = false;
                  }
                  if (X60Qx_373) {
                    X60Qx_372 = (lo_20 < mem.i32(i_18));
                  } else {
                    X60Qx_372 = false;
                  }
                  if (X60Qx_372) {
                    d_1 = mem.i32(i_18);
                  }
                }
              }
              inc_1_I6wjjge_cmdqs323n1(i_18);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_16);
            }
          }
        }
        if ((lo_20 < d_1)) {
          var dt_0 = allocFixed(72);
          mem.copy(dt_0, tok_0_parq39nt2(ps_39, d_1), 72);
          addTree_0_nifjp9lau1(b_25, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1953457155);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_39, b_25, mem.i32((dt_0 + 40)), mem.i32((dt_0 + 44)), pl_25, pc_25, false);
          parseTypeRange_1_parq39nt2(ps_39, b_25, lo_20, d_1, mem.i32((dt_0 + 40)), mem.i32((dt_0 + 44)));
          parseTypeRange_1_parq39nt2(ps_39, b_25, ((d_1 + 1) | 0), hi_19, mem.i32((dt_0 + 40)), mem.i32((dt_0 + 44)));
          endTree_0_nifjp9lau1(b_25);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(dt_0);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_20);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_0);
          return;
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(dt_0);
        }
      }
    }
    {
      var ce_1 = cmdCalleeEnd_0_parq39nt2(ps_39, lo_20, hi_19);
      var X60Qx_59;
      var X60Qx_60;
      var X60Qtmp_23 = allocFixed(72);
      mem.copy(X60Qtmp_23, tok_0_parq39nt2(ps_39, lo_20), 72);
      if ((mem.u8At(X60Qtmp_23) === 1)) {
        X60Qx_60 = (ce_1 < hi_19);
      } else {
        X60Qx_60 = false;
      }
      if (X60Qx_60) {
        var X60Qx_374 = startsArg_0_parq39nt2(ps_39, ce_1, hi_19);
        X60Qx_59 = X60Qx_374;
      } else {
        X60Qx_59 = false;
      }
      if (X60Qx_59) {
        forStmtLabel_14: {
          var callee_1 = allocFixed(72);
          mem.copy(callee_1, tok_0_parq39nt2(ps_39, lo_20), 72);
          addTree_0_nifjp9lau1(b_25, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1684890371);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_39, b_25, mem.i32((callee_1 + 40)), mem.i32((callee_1 + 44)), pl_25, pc_25, false);
          parseTypeRange_1_parq39nt2(ps_39, b_25, lo_20, ce_1, mem.i32((callee_1 + 40)), mem.i32((callee_1 + 44)));
          var starts_4 = allocFixed(8);
          mem.copy(starts_4, splitArgs_0_parq39nt2(ps_39, ce_1, hi_19), 8);
          {
            whileStmtLabel_15: {
              var X60Qlf_16 = 0;
              var X60Qlf_17 = len_3_I0v1j8d_parq39nt2(starts_4);
              var X60Qlf_18 = allocFixed(4);
              mem.setI32(X60Qlf_18, X60Qlf_16);
              {
                while ((mem.i32(X60Qlf_18) < X60Qlf_17)) {
                  {
                    var X60Qx_375 = getQ_7_Ir8kccm_parq39nt2(starts_4, mem.i32(X60Qlf_18));
                    var X60Qii_16 = mem.i32(X60Qx_375);
                    var X60Qx_18;
                    var X60Qx_376 = len_3_I0v1j8d_parq39nt2(starts_4);
                    if ((((mem.i32(X60Qlf_18) + 1) | 0) < X60Qx_376)) {
                      var X60Qx_377 = getQ_7_Ir8kccm_parq39nt2(starts_4, ((mem.i32(X60Qlf_18) + 1) | 0));
                      X60Qx_18 = ((mem.i32(X60Qx_377) - 1) | 0);
                    } else {
                      X60Qx_18 = hi_19;
                    }
                    var X60Qii_17 = X60Qx_18;
                    if ((X60Qii_16 < X60Qii_17)) {
                      parseTypeRange_1_parq39nt2(ps_39, b_25, X60Qii_16, X60Qii_17, mem.i32((callee_1 + 40)), mem.i32((callee_1 + 44)));
                    }
                  }
                  inc_1_I6wjjge_cmdqs323n1(X60Qlf_18);
                }
              }
            }
          }
        }
        endTree_0_nifjp9lau1(b_25);
        eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_4);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(callee_1);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_23);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_20);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_0);
        return;
        eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_4);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(callee_1);
      }
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_23);
    }
  }
  var t_17 = allocFixed(72);
  mem.copy(t_17, tok_0_parq39nt2(ps_39, lo_20), 72);
  addIdent_0_nifjp9lau1(b_25, (t_17 + 4));
  emitInfo_0_parq39nt2(ps_39, b_25, mem.i32((t_17 + 40)), mem.i32((t_17 + 44)), pl_25, pc_25, false);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_17);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_20);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_0);
}

function parseType_1_parq39nt2(ps_40, b_26, idx_2, pl_26, pc_26) {
  let result_23;
  let hi_28 = typeExprEnd_0_parq39nt2(ps_40, idx_2);
  parseTypeRange_1_parq39nt2(ps_40, b_26, idx_2, hi_28, pl_26, pc_26);
  result_23 = hi_28;
  return result_23;
}

function parseTupleInline_1_parq39nt2(ps_41, b_27, lo_21, hi_20, pl_27, pc_27) {
  whileStmtLabel_0: {
    var kw_2 = allocFixed(72);
    mem.copy(kw_2, tok_0_parq39nt2(ps_41, lo_21), 72);
    addTree_0_nifjp9lau1(b_27, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1886745854);
      mem.setU32((_o + 4), strlit_0_I18086024188298164462_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_41, b_27, mem.i32((kw_2 + 40)), mem.i32((kw_2 + 44)), pl_27, pc_27, false);
    var lb_2 = allocFixed(4);
    mem.setI32(lb_2, ((lo_21 + 1) | 0));
    {
      while (true) {
        var X60Qx_61;
        if ((mem.i32(lb_2) < hi_20)) {
          var X60Qtmp_24 = allocFixed(72);
          mem.copy(X60Qtmp_24, tok_0_parq39nt2(ps_41, mem.i32(lb_2)), 72);
          X60Qx_61 = (!(mem.u8At(X60Qtmp_24) === 12));
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_24);
        } else {
          X60Qx_61 = false;
        }
        if (X60Qx_61) {
          inc_1_I6wjjge_cmdqs323n1(lb_2);
        } else {
          break;
        }
      }
    }
  }
  if ((mem.i32(lb_2) < hi_20)) {
    whileStmtLabel_1: {
      var rb_3 = matchClose_0_parq39nt2(ps_41, mem.i32(lb_2));
      var i_19 = allocFixed(4);
      mem.setI32(i_19, ((mem.i32(lb_2) + 1) | 0));
      {
        while ((mem.i32(i_19) < rb_3)) {
          forStmtLabel_4: {
            whileStmtLabel_2: {
              var names_0 = allocFixed(8);
              mem.copy(names_0, newSeqUninit_0_I28kyaw1_lex3r1urc1(0), 8);
              {
                while (true) {
                  var X60Qx_62;
                  if ((mem.i32(i_19) < rb_3)) {
                    var X60Qx_63;
                    var X60Qtmp_25 = allocFixed(72);
                    mem.copy(X60Qtmp_25, tok_0_parq39nt2(ps_41, mem.i32(i_19)), 72);
                    if ((mem.u8At(X60Qtmp_25) === 1)) {
                      X60Qx_63 = true;
                    } else {
                      var X60Qtmp_26 = allocFixed(72);
                      mem.copy(X60Qtmp_26, tok_0_parq39nt2(ps_41, mem.i32(i_19)), 72);
                      X60Qx_63 = (mem.u8At(X60Qtmp_26) === 2);
                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_26);
                    }
                    X60Qx_62 = X60Qx_63;
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_25);
                  } else {
                    X60Qx_62 = false;
                  }
                  if (X60Qx_62) {
                    var X60Qx_378 = allocFixed(72);
                    mem.copy(X60Qx_378, tok_0_parq39nt2(ps_41, mem.i32(i_19)), 72);
                    add_0_Icvfjtn_lex3r1urc1(names_0, X60Qx_378);
                    inc_1_I6wjjge_cmdqs323n1(i_19);
                    var X60Qx_64;
                    if ((mem.i32(i_19) < rb_3)) {
                      var X60Qtmp_27 = allocFixed(72);
                      mem.copy(X60Qtmp_27, tok_0_parq39nt2(ps_41, mem.i32(i_19)), 72);
                      X60Qx_64 = (mem.u8At(X60Qtmp_27) === 16);
                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_27);
                    } else {
                      X60Qx_64 = false;
                    }
                    if (X60Qx_64) {
                      inc_1_I6wjjge_cmdqs323n1(i_19);
                    } else {
                      break whileStmtLabel_2;
                    }
                  } else {
                    break;
                  }
                }
              }
            }
            var tLo_0 = -1;
            var tHi_0 = rb_3;
            var X60Qx_65;
            if ((mem.i32(i_19) < rb_3)) {
              var X60Qtmp_28 = allocFixed(72);
              mem.copy(X60Qtmp_28, tok_0_parq39nt2(ps_41, mem.i32(i_19)), 72);
              X60Qx_65 = (mem.u8At(X60Qtmp_28) === 18);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_28);
            } else {
              X60Qx_65 = false;
            }
            if (X60Qx_65) {
              whileStmtLabel_3: {
                tLo_0 = ((mem.i32(i_19) + 1) | 0);
                var d_2 = allocFixed(4);
                mem.setI32(d_2, 0);
                var k_9 = allocFixed(4);
                mem.setI32(k_9, tLo_0);
                {
                  while ((mem.i32(k_9) < rb_3)) {
                    var kk_2 = allocFixed(72);
                    mem.copy(kk_2, tok_0_parq39nt2(ps_41, mem.i32(k_9)), 72);
                    var X60Qx_379 = isOpenBracket_0_parq39nt2(mem.u8At(kk_2));
                    if (X60Qx_379) {
                      inc_1_I6wjjge_cmdqs323n1(d_2);
                    } else {
                      var X60Qx_380 = isCloseBracket_0_parq39nt2(mem.u8At(kk_2));
                      if (X60Qx_380) {
                        if ((0 < mem.i32(d_2))) {
                          dec_1_I0nzoz91_envto7w6l1(d_2);
                        }
                      } else {
                        var X60Qx_381;
                        if ((mem.i32(d_2) === 0)) {
                          var X60Qx_382;
                          if ((mem.u8At(kk_2) === 16)) {
                            X60Qx_382 = true;
                          } else {
                            X60Qx_382 = (mem.u8At(kk_2) === 17);
                          }
                          X60Qx_381 = X60Qx_382;
                        } else {
                          X60Qx_381 = false;
                        }
                        if (X60Qx_381) {
                          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kk_2);
                          break whileStmtLabel_3;
                        }
                      }
                    }
                    inc_1_I6wjjge_cmdqs323n1(k_9);
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kk_2);
                  }
                }
              }
              tHi_0 = mem.i32(k_9);
              mem.setI32(i_19, mem.i32(k_9));
            }
            var X60Qx_66;
            if ((mem.i32(i_19) < rb_3)) {
              var X60Qx_67;
              var X60Qtmp_29 = allocFixed(72);
              mem.copy(X60Qtmp_29, tok_0_parq39nt2(ps_41, mem.i32(i_19)), 72);
              if ((mem.u8At(X60Qtmp_29) === 16)) {
                X60Qx_67 = true;
              } else {
                var X60Qtmp_30 = allocFixed(72);
                mem.copy(X60Qtmp_30, tok_0_parq39nt2(ps_41, mem.i32(i_19)), 72);
                X60Qx_67 = (mem.u8At(X60Qtmp_30) === 17);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_30);
              }
              X60Qx_66 = X60Qx_67;
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_29);
            } else {
              X60Qx_66 = false;
            }
            if (X60Qx_66) {
              inc_1_I6wjjge_cmdqs323n1(i_19);
            }
            {
              whileStmtLabel_5: {
                var X60Qlf_19 = allocFixed(8);
                mem.copy(X60Qlf_19, toOpenArray_1_I6ofx191_parq39nt2(names_0), 8);
                var X60Qlf_20 = allocFixed(4);
                mem.setI32(X60Qlf_20, 0);
                {
                  while (true) {
                    var X60Qx_383 = len_6_Inwgz45_parq39nt2(X60Qlf_19);
                    if ((mem.i32(X60Qlf_20) < X60Qx_383)) {
                      {
                        var X60Qii_6 = allocFixed(4);
                        mem.setU32(X60Qii_6, getQ_10_Iplfojn1_parq39nt2(X60Qlf_19, mem.i32(X60Qlf_20)));
                        addTree_0_nifjp9lau1(b_27, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 7760642);
                          mem.setU32((_o + 4), 0);
                          return _o;
                        })());
                        emitInfo_0_parq39nt2(ps_41, b_27, mem.i32((mem.u32(X60Qii_6) + 40)), mem.i32((mem.u32(X60Qii_6) + 44)), mem.i32((kw_2 + 40)), mem.i32((kw_2 + 44)), false);
                        addIdent_0_nifjp9lau1(b_27, (mem.u32(X60Qii_6) + 4));
                        emitInfo_0_parq39nt2(ps_41, b_27, mem.i32((mem.u32(X60Qii_6) + 40)), mem.i32((mem.u32(X60Qii_6) + 44)), mem.i32((mem.u32(X60Qii_6) + 40)), mem.i32((mem.u32(X60Qii_6) + 44)), false);
                        if ((0 <= tLo_0)) {
                          parseTypeRange_1_parq39nt2(ps_41, b_27, tLo_0, tHi_0, mem.i32((mem.u32(X60Qii_6) + 40)), mem.i32((mem.u32(X60Qii_6) + 44)));
                        } else {
                          addEmpty_0_nifjp9lau1(b_27, 1);
                        }
                        endTree_0_nifjp9lau1(b_27);
                      }
                      inc_1_I6wjjge_cmdqs323n1(X60Qlf_20);
                    } else {
                      break;
                    }
                  }
                }
              }
            }
          }
          var X60Qx_384 = len_3_Iefkljt1_lex3r1urc1(names_0);
          if ((X60Qx_384 === 0)) {
            inc_1_I6wjjge_cmdqs323n1(i_19);
          }
          eQdestroy_1_Ie8xo6a1_lex3r1urc1(names_0);
        }
      }
    }
  }
  endTree_0_nifjp9lau1(b_27);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_2);
}

function parseProcType_1_parq39nt2(ps_42, b_28, lo_22, hi_21, pl_28, pc_28) {
  whileStmtLabel_0: {
    var kw_3 = allocFixed(72);
    mem.copy(kw_3, tok_0_parq39nt2(ps_42, lo_22), 72);
    var X60Qx_19 = allocFixed(8);
    nimStrWasMoved(X60Qx_19);
    var X60Qx_385 = eqQ_20_sysvq0asl((kw_3 + 4), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1702128126);
      mem.setU32((_o + 4), strlit_0_I9071657656589967445_parq39nt2);
      return _o;
    })());
    if (X60Qx_385) {
      nimStrDestroy(X60Qx_19);
      mem.copy(X60Qx_19, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1702128126);
        mem.setU32((_o + 4), strlit_0_I15938251790995683266_parq39nt2);
        return _o;
      })(), 8);
    } else {
      nimStrDestroy(X60Qx_19);
      mem.copy(X60Qx_19, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1869771006);
        mem.setU32((_o + 4), strlit_0_I1995551610468546737_parq39nt2);
        return _o;
      })(), 8);
    }
    var tag_10 = allocFixed(8);
    mem.copy(tag_10, X60Qx_19, 8);
    nimStrWasMoved(X60Qx_19);
    var lp_1 = allocFixed(4);
    mem.setI32(lp_1, ((lo_22 + 1) | 0));
    {
      while (true) {
        var X60Qx_68;
        if ((mem.i32(lp_1) < hi_21)) {
          var X60Qtmp_31 = allocFixed(72);
          mem.copy(X60Qtmp_31, tok_0_parq39nt2(ps_42, mem.i32(lp_1)), 72);
          X60Qx_68 = (!(mem.u8At(X60Qtmp_31) === 10));
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_31);
        } else {
          X60Qx_68 = false;
        }
        if (X60Qx_68) {
          inc_1_I6wjjge_cmdqs323n1(lp_1);
        } else {
          break;
        }
      }
    }
  }
  addTree_0_nifjp9lau1(b_28, tag_10);
  if ((mem.i32(lp_1) < hi_21)) {
    var lpTok_0 = allocFixed(72);
    mem.copy(lpTok_0, tok_0_parq39nt2(ps_42, mem.i32(lp_1)), 72);
    emitInfo_0_parq39nt2(ps_42, b_28, mem.i32((lpTok_0 + 40)), mem.i32((lpTok_0 + 44)), pl_28, pc_28, false);
    addEmpty_0_nifjp9lau1(b_28, 4);
    var i_20 = parseParams_1_parq39nt2(ps_42, b_28, mem.i32(lp_1), mem.i32((lpTok_0 + 40)), mem.i32((lpTok_0 + 44)));
    var X60Qtmp_32 = allocFixed(72);
    mem.copy(X60Qtmp_32, tok_0_parq39nt2(ps_42, i_20), 72);
    if ((mem.u8At(X60Qtmp_32) === 14)) {
      var X60Qx_386 = parsePragmas_1_parq39nt2(ps_42, b_28, i_20, mem.i32((lpTok_0 + 40)), mem.i32((lpTok_0 + 44)));
      i_20 = X60Qx_386;
    } else {
      addEmpty_0_nifjp9lau1(b_28, 1);
    }
    addEmpty_0_nifjp9lau1(b_28, 2);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_32);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(lpTok_0);
  } else {
    emitInfo_0_parq39nt2(ps_42, b_28, mem.i32((kw_3 + 40)), mem.i32((kw_3 + 44)), pl_28, pc_28, false);
    addEmpty_0_nifjp9lau1(b_28, 8);
  }
  endTree_0_nifjp9lau1(b_28);
  nimStrDestroy(tag_10);
  nimStrDestroy(X60Qx_19);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_3);
}

function parsePragmas_1_parq39nt2(ps_43, b_29, braceIdx_1, pl_29, pc_29) {
  forStmtLabel_0: {
    var result_24;
    var brace_0 = allocFixed(72);
    mem.copy(brace_0, tok_0_parq39nt2(ps_43, braceIdx_1), 72);
    var rb_4 = matchClose_0_parq39nt2(ps_43, braceIdx_1);
    addTree_0_nifjp9lau1(b_29, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1634889982);
      mem.setU32((_o + 4), strlit_0_I7023501325319911082_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_43, b_29, mem.i32((brace_0 + 40)), mem.i32((brace_0 + 44)), pl_29, pc_29, false);
    var lo_28 = allocFixed(4);
    mem.setI32(lo_28, ((braceIdx_1 + 1) | 0));
    var X60Qx_69;
    if ((mem.i32(lo_28) < rb_4)) {
      var X60Qtmp_33 = allocFixed(72);
      mem.copy(X60Qtmp_33, tok_0_parq39nt2(ps_43, mem.i32(lo_28)), 72);
      X60Qx_69 = (mem.u8At(X60Qtmp_33) === 19);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_33);
    } else {
      X60Qx_69 = false;
    }
    if (X60Qx_69) {
      inc_1_I6wjjge_cmdqs323n1(lo_28);
    }
    var hi_29 = allocFixed(4);
    mem.setI32(hi_29, rb_4);
    var X60Qx_70;
    if ((mem.i32(lo_28) <= ((mem.i32(hi_29) - 1) | 0))) {
      var X60Qtmp_34 = allocFixed(72);
      mem.copy(X60Qtmp_34, tok_0_parq39nt2(ps_43, ((mem.i32(hi_29) - 1) | 0)), 72);
      X60Qx_70 = (mem.u8At(X60Qtmp_34) === 19);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_34);
    } else {
      X60Qx_70 = false;
    }
    if (X60Qx_70) {
      dec_1_I0nzoz91_envto7w6l1(hi_29);
    }
    var X60Qx_71;
    if ((((mem.i32(lo_28) + 1) | 0) < mem.i32(hi_29))) {
      var X60Qx_72;
      var X60Qtmp_35 = allocFixed(72);
      mem.copy(X60Qtmp_35, tok_0_parq39nt2(ps_43, mem.i32(lo_28)), 72);
      if ((mem.u8At(X60Qtmp_35) === 1)) {
        X60Qx_72 = true;
      } else {
        var X60Qtmp_36 = allocFixed(72);
        mem.copy(X60Qtmp_36, tok_0_parq39nt2(ps_43, mem.i32(lo_28)), 72);
        X60Qx_72 = (mem.u8At(X60Qtmp_36) === 2);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_36);
      }
      X60Qx_71 = X60Qx_72;
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_35);
    } else {
      X60Qx_71 = false;
    }
    if (X60Qx_71) {
      var nxt_4 = allocFixed(72);
      mem.copy(nxt_4, tok_0_parq39nt2(ps_43, ((mem.i32(lo_28) + 1) | 0)), 72);
      var X60Qx_387;
      var X60Qx_388;
      var X60Qx_389;
      var X60Qx_390;
      if ((mem.u8At(nxt_4) === 1)) {
        X60Qx_390 = true;
      } else {
        X60Qx_390 = (mem.u8At(nxt_4) === 2);
      }
      if (X60Qx_390) {
        X60Qx_389 = true;
      } else {
        X60Qx_389 = (mem.u8At(nxt_4) === 5);
      }
      if (X60Qx_389) {
        X60Qx_388 = true;
      } else {
        X60Qx_388 = (mem.u8At(nxt_4) === 3);
      }
      if (X60Qx_388) {
        X60Qx_387 = true;
      } else {
        X60Qx_387 = (mem.u8At(nxt_4) === 4);
      }
      if (X60Qx_387) {
        var X60Qtmp_37 = allocFixed(72);
        mem.copy(X60Qtmp_37, tok_0_parq39nt2(ps_43, mem.i32(lo_28)), 72);
        emitName_0_parq39nt2(ps_43, b_29, X60Qtmp_37, mem.i32((brace_0 + 40)), mem.i32((brace_0 + 44)));
        inc_1_I6wjjge_cmdqs323n1(lo_28);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_37);
      }
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nxt_4);
    }
    var starts_5 = allocFixed(8);
    mem.copy(starts_5, splitArgs_0_parq39nt2(ps_43, mem.i32(lo_28), mem.i32(hi_29)), 8);
    {
      whileStmtLabel_1: {
        var X60Qlf_21 = 0;
        var X60Qlf_22 = len_3_I0v1j8d_parq39nt2(starts_5);
        var X60Qlf_23 = allocFixed(4);
        mem.setI32(X60Qlf_23, X60Qlf_21);
        {
          while ((mem.i32(X60Qlf_23) < X60Qlf_22)) {
            {
              var X60Qx_391 = getQ_7_Ir8kccm_parq39nt2(starts_5, mem.i32(X60Qlf_23));
              var X60Qii_2 = allocFixed(4);
              mem.setI32(X60Qii_2, mem.i32(X60Qx_391));
              var X60Qx_20;
              var X60Qx_392 = len_3_I0v1j8d_parq39nt2(starts_5);
              if ((((mem.i32(X60Qlf_23) + 1) | 0) < X60Qx_392)) {
                var X60Qx_393 = getQ_7_Ir8kccm_parq39nt2(starts_5, ((mem.i32(X60Qlf_23) + 1) | 0));
                X60Qx_20 = ((mem.i32(X60Qx_393) - 1) | 0);
              } else {
                X60Qx_20 = mem.i32(hi_29);
              }
              var X60Qii_3 = allocFixed(4);
              mem.setI32(X60Qii_3, X60Qx_20);
              if ((mem.i32(X60Qii_2) < mem.i32(X60Qii_3))) {
                parseArg_0_parq39nt2(ps_43, b_29, mem.i32(X60Qii_2), mem.i32(X60Qii_3), mem.i32((brace_0 + 40)), mem.i32((brace_0 + 44)));
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_23);
          }
        }
      }
    }
  }
  endTree_0_nifjp9lau1(b_29);
  result_24 = ((rb_4 + 1) | 0);
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_5);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(brace_0);
  return result_24;
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_5);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(brace_0);
  return result_24;
}

function emitTypevarGroup_0_parq39nt2(ps_44, b_30, gLo_0, gHi_0, tvL_0, tvC_0) {
  forStmtLabel_1: {
    whileStmtLabel_0: {
      var ci_1 = allocFixed(4);
      mem.setI32(ci_1, gLo_0);
      var names_1 = allocFixed(8);
      mem.copy(names_1, newSeqUninit_0_I28kyaw1_lex3r1urc1(0), 8);
      {
        while (true) {
          var X60Qx_73;
          if ((mem.i32(ci_1) < gHi_0)) {
            var X60Qx_74;
            var X60Qtmp_38 = allocFixed(72);
            mem.copy(X60Qtmp_38, tok_0_parq39nt2(ps_44, mem.i32(ci_1)), 72);
            if ((mem.u8At(X60Qtmp_38) === 1)) {
              X60Qx_74 = true;
            } else {
              var X60Qtmp_39 = allocFixed(72);
              mem.copy(X60Qtmp_39, tok_0_parq39nt2(ps_44, mem.i32(ci_1)), 72);
              X60Qx_74 = (mem.u8At(X60Qtmp_39) === 2);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_39);
            }
            X60Qx_73 = X60Qx_74;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_38);
          } else {
            X60Qx_73 = false;
          }
          if (X60Qx_73) {
            var X60Qx_394 = allocFixed(72);
            mem.copy(X60Qx_394, tok_0_parq39nt2(ps_44, mem.i32(ci_1)), 72);
            add_0_Icvfjtn_lex3r1urc1(names_1, X60Qx_394);
            inc_1_I6wjjge_cmdqs323n1(ci_1);
            var X60Qx_75;
            if ((mem.i32(ci_1) < gHi_0)) {
              var X60Qtmp_40 = allocFixed(72);
              mem.copy(X60Qtmp_40, tok_0_parq39nt2(ps_44, mem.i32(ci_1)), 72);
              X60Qx_75 = (mem.u8At(X60Qtmp_40) === 16);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_40);
            } else {
              X60Qx_75 = false;
            }
            if (X60Qx_75) {
              inc_1_I6wjjge_cmdqs323n1(ci_1);
            } else {
              break whileStmtLabel_0;
            }
          } else {
            break;
          }
        }
      }
    }
    var cLo_0 = -1;
    var cHi_0 = gHi_0;
    var X60Qx_76;
    if ((mem.i32(ci_1) < gHi_0)) {
      var X60Qtmp_41 = allocFixed(72);
      mem.copy(X60Qtmp_41, tok_0_parq39nt2(ps_44, mem.i32(ci_1)), 72);
      X60Qx_76 = (mem.u8At(X60Qtmp_41) === 18);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_41);
    } else {
      X60Qx_76 = false;
    }
    if (X60Qx_76) {
      cLo_0 = ((mem.i32(ci_1) + 1) | 0);
    }
    {
      whileStmtLabel_2: {
        var X60Qlf_24 = allocFixed(8);
        mem.copy(X60Qlf_24, toOpenArray_1_I6ofx191_parq39nt2(names_1), 8);
        var X60Qlf_25 = allocFixed(4);
        mem.setI32(X60Qlf_25, 0);
        {
          while (true) {
            var X60Qx_395 = len_6_Inwgz45_parq39nt2(X60Qlf_24);
            if ((mem.i32(X60Qlf_25) < X60Qx_395)) {
              {
                var X60Qii_3 = allocFixed(4);
                mem.setU32(X60Qii_3, getQ_10_Iplfojn1_parq39nt2(X60Qlf_24, mem.i32(X60Qlf_25)));
                addTree_0_nifjp9lau1(b_30, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1887007998);
                  mem.setU32((_o + 4), strlit_0_I3759916806223351059_parq39nt2);
                  return _o;
                })());
                emitInfo_0_parq39nt2(ps_44, b_30, mem.i32((mem.u32(X60Qii_3) + 40)), mem.i32((mem.u32(X60Qii_3) + 44)), tvL_0, tvC_0, false);
                addIdent_0_nifjp9lau1(b_30, (mem.u32(X60Qii_3) + 4));
                emitInfo_0_parq39nt2(ps_44, b_30, mem.i32((mem.u32(X60Qii_3) + 40)), mem.i32((mem.u32(X60Qii_3) + 44)), mem.i32((mem.u32(X60Qii_3) + 40)), mem.i32((mem.u32(X60Qii_3) + 44)), false);
                addEmpty_0_nifjp9lau1(b_30, 1);
                addEmpty_0_nifjp9lau1(b_30, 1);
                if ((0 <= cLo_0)) {
                  parseTypeRange_1_parq39nt2(ps_44, b_30, cLo_0, cHi_0, mem.i32((mem.u32(X60Qii_3) + 40)), mem.i32((mem.u32(X60Qii_3) + 44)));
                } else {
                  addEmpty_0_nifjp9lau1(b_30, 1);
                }
                addEmpty_0_nifjp9lau1(b_30, 1);
                endTree_0_nifjp9lau1(b_30);
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_25);
            } else {
              break;
            }
          }
        }
      }
    }
  }
  eQdestroy_1_Ie8xo6a1_lex3r1urc1(names_1);
}

function parseGenerics_1_parq39nt2(ps_45, b_31, lbIdx_1, pl_30, pc_30) {
  whileStmtLabel_0: {
    var result_25;
    var lb_3 = allocFixed(72);
    mem.copy(lb_3, tok_0_parq39nt2(ps_45, lbIdx_1), 72);
    var rb_5 = matchClose_0_parq39nt2(ps_45, lbIdx_1);
    addTree_0_nifjp9lau1(b_31, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1887007998);
      mem.setU32((_o + 4), strlit_0_I14656641239204103783_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_45, b_31, mem.i32((lb_3 + 40)), mem.i32((lb_3 + 44)), pl_30, pc_30, false);
    var gstart_0 = ((lbIdx_1 + 1) | 0);
    var i_21 = allocFixed(4);
    mem.setI32(i_21, ((lbIdx_1 + 1) | 0));
    var depth_12 = allocFixed(4);
    mem.setI32(depth_12, 0);
    {
      while ((mem.i32(i_21) < rb_5)) {
        var X60Qtmp_42 = allocFixed(72);
        mem.copy(X60Qtmp_42, tok_0_parq39nt2(ps_45, mem.i32(i_21)), 72);
        var k_10 = mem.u8At(X60Qtmp_42);
        var X60Qx_396 = isOpenBracket_0_parq39nt2(k_10);
        if (X60Qx_396) {
          inc_1_I6wjjge_cmdqs323n1(depth_12);
        } else {
          var X60Qx_397 = isCloseBracket_0_parq39nt2(k_10);
          if (X60Qx_397) {
            if ((0 < mem.i32(depth_12))) {
              dec_1_I0nzoz91_envto7w6l1(depth_12);
            }
          } else {
            var X60Qx_77;
            if ((mem.i32(depth_12) === 0)) {
              var X60Qtmp_43 = allocFixed(72);
              mem.copy(X60Qtmp_43, tok_0_parq39nt2(ps_45, mem.i32(i_21)), 72);
              X60Qx_77 = (mem.u8At(X60Qtmp_43) === 17);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_43);
            } else {
              X60Qx_77 = false;
            }
            if (X60Qx_77) {
              emitTypevarGroup_0_parq39nt2(ps_45, b_31, gstart_0, mem.i32(i_21), mem.i32((lb_3 + 40)), mem.i32((lb_3 + 44)));
              gstart_0 = ((mem.i32(i_21) + 1) | 0);
            }
          }
        }
        inc_1_I6wjjge_cmdqs323n1(i_21);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_42);
      }
    }
  }
  if ((gstart_0 < rb_5)) {
    emitTypevarGroup_0_parq39nt2(ps_45, b_31, gstart_0, rb_5, mem.i32((lb_3 + 40)), mem.i32((lb_3 + 44)));
  }
  endTree_0_nifjp9lau1(b_31);
  result_25 = ((rb_5 + 1) | 0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(lb_3);
  return result_25;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(lb_3);
  return result_25;
}

function splitFieldName_0_parq39nt2(ps_46, i_3, hi_22, nameTok_0, hasExport_0, pragLo_0, pragHi_0) {
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nameTok_0);
  let X60Qx_398 = allocFixed(72);
  mem.copy(X60Qx_398, tok_0_parq39nt2(ps_46, mem.i32(i_3)), 72);
  mem.copy(nameTok_0, X60Qx_398, 72);
  mem.setU8(hasExport_0, false);
  mem.setI32(pragLo_0, -1);
  mem.setI32(pragHi_0, -1);
  inc_1_I6wjjge_cmdqs323n1(i_3);
  let X60Qx_78;
  let X60Qx_79;
  if ((mem.i32(i_3) < hi_22)) {
    let X60Qtmp_44 = allocFixed(72);
    mem.copy(X60Qtmp_44, tok_0_parq39nt2(ps_46, mem.i32(i_3)), 72);
    X60Qx_79 = (mem.u8At(X60Qtmp_44) === 9);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_44);
  } else {
    X60Qx_79 = false;
  }
  if (X60Qx_79) {
    let X60Qtmp_45 = allocFixed(72);
    mem.copy(X60Qtmp_45, tok_0_parq39nt2(ps_46, mem.i32(i_3)), 72);
    let X60Qx_399 = eqQ_20_sysvq0asl((X60Qtmp_45 + 4), (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 10753);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    X60Qx_78 = X60Qx_399;
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_45);
  } else {
    X60Qx_78 = false;
  }
  if (X60Qx_78) {
    mem.setU8(hasExport_0, true);
    inc_1_I6wjjge_cmdqs323n1(i_3);
  }
  let X60Qx_80;
  if ((mem.i32(i_3) < hi_22)) {
    let X60Qtmp_46 = allocFixed(72);
    mem.copy(X60Qtmp_46, tok_0_parq39nt2(ps_46, mem.i32(i_3)), 72);
    X60Qx_80 = (mem.u8At(X60Qtmp_46) === 14);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_46);
  } else {
    X60Qx_80 = false;
  }
  if (X60Qx_80) {
    let rb_6 = matchClose_0_parq39nt2(ps_46, mem.i32(i_3));
    mem.setI32(pragLo_0, mem.i32(i_3));
    mem.setI32(pragHi_0, rb_6);
    mem.setI32(i_3, ((rb_6 + 1) | 0));
  }
}

function emitPragmaSlot_0_parq39nt2(ps_47, b_32, pragLo_1, pragHi_1, pl_31, pc_31) {
  if ((0 <= pragLo_1)) {
    let X60Qx_400 = parsePragmas_1_parq39nt2(ps_47, b_32, pragLo_1, pl_31, pc_31);
  } else {
    addEmpty_0_nifjp9lau1(b_32, 1);
  }
}

function emitFieldLine_0_parq39nt2(ps_48, b_33, fi_0, lineHi_0, kl_0, kc_0) {
  forStmtLabel_1: {
    whileStmtLabel_0: {
      var j_1 = allocFixed(4);
      mem.setI32(j_1, fi_0);
      var names_2 = allocFixed(8);
      mem.copy(names_2, newSeqUninit_0_I28kyaw1_lex3r1urc1(0), 8);
      var exports_0 = allocFixed(8);
      mem.copy(exports_0, newSeqUninit_0_I5mozxi1_parq39nt2(0), 8);
      var firstPragLo_0 = -1;
      var firstPragHi_0 = -1;
      {
        while (true) {
          var X60Qx_81;
          if ((mem.i32(j_1) < lineHi_0)) {
            var X60Qtmp_47 = allocFixed(72);
            mem.copy(X60Qtmp_47, tok_0_parq39nt2(ps_48, mem.i32(j_1)), 72);
            X60Qx_81 = (mem.u8At(X60Qtmp_47) === 1);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_47);
          } else {
            X60Qx_81 = false;
          }
          if (X60Qx_81) {
            var nm_4 = allocFixed(72);
            mem.copy(nm_4, tok_0_parq39nt2(ps_48, mem.i32(j_1)), 72);
            var ex_0 = allocFixed(1);
            mem.setU8(ex_0, false);
            var pl2_0 = allocFixed(4);
            mem.setI32(pl2_0, -1);
            var ph2_0 = allocFixed(4);
            mem.setI32(ph2_0, -1);
            splitFieldName_0_parq39nt2(ps_48, j_1, lineHi_0, nm_4, ex_0, pl2_0, ph2_0);
            var X60Qtmp_48 = allocFixed(72);
            mem.copy(X60Qtmp_48, nm_4, 72);
            eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(nm_4);
            add_0_Icvfjtn_lex3r1urc1(names_2, X60Qtmp_48);
            add_0_Irnc3p1_parq39nt2(exports_0, mem.u8At(ex_0));
            var X60Qx_401;
            if ((0 <= mem.i32(pl2_0))) {
              X60Qx_401 = (firstPragLo_0 < 0);
            } else {
              X60Qx_401 = false;
            }
            if (X60Qx_401) {
              firstPragLo_0 = mem.i32(pl2_0);
              firstPragHi_0 = mem.i32(ph2_0);
            }
            var X60Qx_82;
            if ((mem.i32(j_1) < lineHi_0)) {
              var X60Qtmp_49 = allocFixed(72);
              mem.copy(X60Qtmp_49, tok_0_parq39nt2(ps_48, mem.i32(j_1)), 72);
              X60Qx_82 = (mem.u8At(X60Qtmp_49) === 16);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_49);
            } else {
              X60Qx_82 = false;
            }
            if (X60Qx_82) {
              inc_1_I6wjjge_cmdqs323n1(j_1);
            } else {
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nm_4);
              break whileStmtLabel_0;
            }
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nm_4);
          } else {
            break;
          }
        }
      }
    }
    var tLo_1 = -1;
    var tHi_1 = lineHi_0;
    var vLo_0 = -1;
    var X60Qx_83;
    if ((mem.i32(j_1) < lineHi_0)) {
      var X60Qtmp_50 = allocFixed(72);
      mem.copy(X60Qtmp_50, tok_0_parq39nt2(ps_48, mem.i32(j_1)), 72);
      X60Qx_83 = (mem.u8At(X60Qtmp_50) === 18);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_50);
    } else {
      X60Qx_83 = false;
    }
    if (X60Qx_83) {
      inc_1_I6wjjge_cmdqs323n1(j_1);
      tLo_1 = mem.i32(j_1);
      var X60Qx_402 = typeExprEnd_0_parq39nt2(ps_48, mem.i32(j_1));
      tHi_1 = X60Qx_402;
      mem.setI32(j_1, tHi_1);
      var X60Qx_84;
      if ((mem.i32(j_1) < lineHi_0)) {
        var X60Qtmp_51 = allocFixed(72);
        mem.copy(X60Qtmp_51, tok_0_parq39nt2(ps_48, mem.i32(j_1)), 72);
        X60Qx_84 = (mem.u8At(X60Qtmp_51) === 14);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_51);
      } else {
        X60Qx_84 = false;
      }
      if (X60Qx_84) {
        var X60Qx_403 = matchClose_0_parq39nt2(ps_48, mem.i32(j_1));
        mem.setI32(j_1, ((X60Qx_403 + 1) | 0));
        tHi_1 = mem.i32(j_1);
      }
    }
    var X60Qx_85;
    var X60Qx_86;
    if ((mem.i32(j_1) < lineHi_0)) {
      var X60Qtmp_52 = allocFixed(72);
      mem.copy(X60Qtmp_52, tok_0_parq39nt2(ps_48, mem.i32(j_1)), 72);
      X60Qx_86 = (mem.u8At(X60Qtmp_52) === 9);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_52);
    } else {
      X60Qx_86 = false;
    }
    if (X60Qx_86) {
      var X60Qtmp_53 = allocFixed(72);
      mem.copy(X60Qtmp_53, tok_0_parq39nt2(ps_48, mem.i32(j_1)), 72);
      var X60Qx_404 = eqQ_20_sysvq0asl((X60Qtmp_53 + 4), (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 15617);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      X60Qx_85 = X60Qx_404;
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_53);
    } else {
      X60Qx_85 = false;
    }
    if (X60Qx_85) {
      vLo_0 = ((mem.i32(j_1) + 1) | 0);
    }
    {
      whileStmtLabel_2: {
        var X60Qlf_26 = 0;
        var X60Qlf_27 = len_3_Iefkljt1_lex3r1urc1(names_2);
        var X60Qlf_28 = allocFixed(4);
        mem.setI32(X60Qlf_28, X60Qlf_26);
        {
          while ((mem.i32(X60Qlf_28) < X60Qlf_27)) {
            {
              var X60Qx_405 = getQ_7_Ijq9cyk1_lex3r1urc1(names_2, mem.i32(X60Qlf_28));
              var X60QconstRefTemp_0 = allocFixed(72);
              mem.copy(X60QconstRefTemp_0, X60Qx_405, 72);
              var X60Qii_3 = allocFixed(72);
              mem.copy(X60Qii_3, eQdupQ_SX54oken0tok9e79hf_0_tok9e79hf(X60QconstRefTemp_0), 72);
              addTree_0_nifjp9lau1(b_33, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1684825603);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              emitInfo_0_parq39nt2(ps_48, b_33, mem.i32((X60Qii_3 + 40)), mem.i32((X60Qii_3 + 44)), kl_0, kc_0, false);
              addIdent_0_nifjp9lau1(b_33, (X60Qii_3 + 4));
              emitInfo_0_parq39nt2(ps_48, b_33, mem.i32((X60Qii_3 + 40)), mem.i32((X60Qii_3 + 44)), mem.i32((X60Qii_3 + 40)), mem.i32((X60Qii_3 + 44)), false);
              var X60Qx_406 = getQ_7_Iul1no9_parq39nt2(exports_0, mem.i32(X60Qlf_28));
              if (mem.u8At(X60Qx_406)) {
                addRaw_0_nifjp9lau1(b_33, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 7872514);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
              } else {
                addEmpty_0_nifjp9lau1(b_33, 1);
              }
              emitPragmaSlot_0_parq39nt2(ps_48, b_33, firstPragLo_0, firstPragHi_0, mem.i32((X60Qii_3 + 40)), mem.i32((X60Qii_3 + 44)));
              if ((0 <= tLo_1)) {
                parseTypeRange_1_parq39nt2(ps_48, b_33, tLo_1, tHi_1, mem.i32((X60Qii_3 + 40)), mem.i32((X60Qii_3 + 44)));
              } else {
                addEmpty_0_nifjp9lau1(b_33, 1);
              }
              if ((0 <= vLo_0)) {
                parseExprRange_1_parq39nt2(ps_48, b_33, vLo_0, lineHi_0, mem.i32((X60Qii_3 + 40)), mem.i32((X60Qii_3 + 44)));
              } else {
                addEmpty_0_nifjp9lau1(b_33, 1);
              }
              endTree_0_nifjp9lau1(b_33);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_3);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_28);
          }
        }
      }
    }
  }
  eQdestroy_1_I7a20g9_parq39nt2(exports_0);
  eQdestroy_1_Ie8xo6a1_lex3r1urc1(names_2);
}

function emitFieldBody_0_parq39nt2(ps_49, b_34, colonIdx_0, defIndent_2, kl_1, kc_1) {
  var result_26;
  var bodyStart_0 = ((colonIdx_0 + 1) | 0);
  var first_1 = allocFixed(72);
  mem.copy(first_1, tok_0_parq39nt2(ps_49, bodyStart_0), 72);
  if ((mem.i32((first_1 + 52)) < 0)) {
    var hi_30 = lineEnd_0_parq39nt2(ps_49, bodyStart_0);
    emitFieldLine_0_parq39nt2(ps_49, b_34, bodyStart_0, hi_30, kl_1, kc_1);
    result_26 = hi_30;
  } else {
    whileStmtLabel_0: {
      addTree_0_nifjp9lau1(b_34, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1836348414);
        mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_49, b_34, mem.i32((first_1 + 40)), mem.i32((first_1 + 44)), kl_1, kc_1, false);
      var i_23 = allocFixed(4);
      mem.setI32(i_23, bodyStart_0);
      {
        while (true) {
          var X60Qx_87;
          var X60Qtmp_54 = allocFixed(72);
          mem.copy(X60Qtmp_54, tok_0_parq39nt2(ps_49, mem.i32(i_23)), 72);
          if ((!(mem.u8At(X60Qtmp_54) === 0))) {
            var X60Qtmp_55 = allocFixed(72);
            mem.copy(X60Qtmp_55, tok_0_parq39nt2(ps_49, mem.i32(i_23)), 72);
            X60Qx_87 = (defIndent_2 < mem.i32((X60Qtmp_55 + 52)));
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_55);
          } else {
            X60Qx_87 = false;
          }
          if (X60Qx_87) {
            continueLabel_1: {
              {
                var X60Qtmp_56 = allocFixed(72);
                mem.copy(X60Qtmp_56, tok_0_parq39nt2(ps_49, mem.i32(i_23)), 72);
                if ((mem.u8At(X60Qtmp_56) === 20)) {
                  inc_1_I6wjjge_cmdqs323n1(i_23);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_56);
                  break continueLabel_1;
                }
                var lh_0 = lineEnd_0_parq39nt2(ps_49, mem.i32(i_23));
                emitFieldLine_0_parq39nt2(ps_49, b_34, mem.i32(i_23), lh_0, mem.i32((first_1 + 40)), mem.i32((first_1 + 44)));
                mem.setI32(i_23, lh_0);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_56);
              }
            }
          } else {
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_54);
            break;
          }
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_54);
        }
      }
    }
    endTree_0_nifjp9lau1(b_34);
    result_26 = mem.i32(i_23);
  }
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_1);
  return result_26;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_1);
  return result_26;
}

function parseObjectCase_0_parq39nt2(ps_50, b_35, caseIdx_0, defIndent_3, kl_2, kc_2) {
  whileStmtLabel_0: {
    var result_27;
    var kw_4 = allocFixed(72);
    mem.copy(kw_4, tok_0_parq39nt2(ps_50, caseIdx_0), 72);
    addTree_0_nifjp9lau1(b_35, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1935762430);
      mem.setU32((_o + 4), strlit_0_I4956278306908871092_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_50, b_35, mem.i32((kw_4 + 40)), mem.i32((kw_4 + 44)), kl_2, kc_2, false);
    var caseHi_0 = lineEnd_0_parq39nt2(ps_50, caseIdx_0);
    emitFieldLine_0_parq39nt2(ps_50, b_35, ((caseIdx_0 + 1) | 0), caseHi_0, mem.i32((kw_4 + 40)), mem.i32((kw_4 + 44)));
    var i_24 = caseHi_0;
    var refIndent_1 = mem.i32((kw_4 + 44));
    {
      while (true) {
        var X60Qx_88;
        var X60Qx_89;
        var X60Qx_90;
        var X60Qtmp_57 = allocFixed(72);
        mem.copy(X60Qtmp_57, tok_0_parq39nt2(ps_50, i_24), 72);
        if ((!(mem.u8At(X60Qtmp_57) === 0))) {
          var X60Qtmp_58 = allocFixed(72);
          mem.copy(X60Qtmp_58, tok_0_parq39nt2(ps_50, i_24), 72);
          X60Qx_90 = (refIndent_1 <= mem.i32((X60Qtmp_58 + 52)));
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_58);
        } else {
          X60Qx_90 = false;
        }
        if (X60Qx_90) {
          var X60Qtmp_59 = allocFixed(72);
          mem.copy(X60Qtmp_59, tok_0_parq39nt2(ps_50, i_24), 72);
          X60Qx_89 = (mem.u8At(X60Qtmp_59) === 2);
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_59);
        } else {
          X60Qx_89 = false;
        }
        if (X60Qx_89) {
          var X60Qx_91;
          var X60Qx_92;
          var X60Qtmp_60 = allocFixed(72);
          mem.copy(X60Qtmp_60, tok_0_parq39nt2(ps_50, i_24), 72);
          var X60Qx_407 = eqQ_20_sysvq0asl((X60Qtmp_60 + 4), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 6713090);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          if (X60Qx_407) {
            X60Qx_92 = true;
          } else {
            var X60Qtmp_61 = allocFixed(72);
            mem.copy(X60Qtmp_61, tok_0_parq39nt2(ps_50, i_24), 72);
            var X60Qx_408 = eqQ_20_sysvq0asl((X60Qtmp_61 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1936483838);
              mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
              return _o;
            })());
            X60Qx_92 = X60Qx_408;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_61);
          }
          if (X60Qx_92) {
            X60Qx_91 = true;
          } else {
            var X60Qtmp_62 = allocFixed(72);
            mem.copy(X60Qtmp_62, tok_0_parq39nt2(ps_50, i_24), 72);
            var X60Qx_409 = eqQ_20_sysvq0asl((X60Qtmp_62 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1768711678);
              mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
              return _o;
            })());
            X60Qx_91 = X60Qx_409;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_62);
          }
          X60Qx_88 = X60Qx_91;
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_60);
        } else {
          X60Qx_88 = false;
        }
        if (X60Qx_88) {
          var br_0 = allocFixed(72);
          mem.copy(br_0, tok_0_parq39nt2(ps_50, i_24), 72);
          var bhi_0 = lineEnd_0_parq39nt2(ps_50, i_24);
          var bcolon_0 = findColon_0_parq39nt2(ps_50, i_24, bhi_0);
          var X60Qx_410 = eqQ_20_sysvq0asl((br_0 + 4), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 6713090);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          if (X60Qx_410) {
            forStmtLabel_1: {
              addTree_0_nifjp9lau1(b_35, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 6713090);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              emitInfo_0_parq39nt2(ps_50, b_35, mem.i32((br_0 + 40)), mem.i32((br_0 + 44)), mem.i32((kw_4 + 40)), mem.i32((kw_4 + 44)), false);
              addTree_0_nifjp9lau1(b_35, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1851880190);
                mem.setU32((_o + 4), strlit_0_I10760563625686142994_parq39nt2);
                return _o;
              })());
              emitInfo_0_parq39nt2(ps_50, b_35, mem.i32((br_0 + 40)), mem.i32((br_0 + 44)), mem.i32((br_0 + 40)), mem.i32((br_0 + 44)), false);
              var X60Qx_21;
              if ((0 <= bcolon_0)) {
                X60Qx_21 = bcolon_0;
              } else {
                X60Qx_21 = bhi_0;
              }
              var vals_0 = allocFixed(8);
              mem.copy(vals_0, splitArgs_0_parq39nt2(ps_50, ((i_24 + 1) | 0), X60Qx_21), 8);
              {
                whileStmtLabel_2: {
                  var X60Qlf_29 = 0;
                  var X60Qlf_30 = len_3_I0v1j8d_parq39nt2(vals_0);
                  var X60Qlf_31 = allocFixed(4);
                  mem.setI32(X60Qlf_31, X60Qlf_29);
                  {
                    while ((mem.i32(X60Qlf_31) < X60Qlf_30)) {
                      {
                        var X60Qx_411 = getQ_7_Ir8kccm_parq39nt2(vals_0, mem.i32(X60Qlf_31));
                        var X60Qii_3 = allocFixed(4);
                        mem.setI32(X60Qii_3, mem.i32(X60Qx_411));
                        var X60Qx_22;
                        var X60Qx_412 = len_3_I0v1j8d_parq39nt2(vals_0);
                        if ((((mem.i32(X60Qlf_31) + 1) | 0) < X60Qx_412)) {
                          var X60Qx_413 = getQ_7_Ir8kccm_parq39nt2(vals_0, ((mem.i32(X60Qlf_31) + 1) | 0));
                          X60Qx_22 = ((mem.i32(X60Qx_413) - 1) | 0);
                        } else {
                          var X60Qx_23;
                          if ((0 <= bcolon_0)) {
                            X60Qx_23 = bcolon_0;
                          } else {
                            X60Qx_23 = bhi_0;
                          }
                          X60Qx_22 = X60Qx_23;
                        }
                        var X60Qii_4 = X60Qx_22;
                        if ((mem.i32(X60Qii_3) < X60Qii_4)) {
                          parseExprRange_1_parq39nt2(ps_50, b_35, mem.i32(X60Qii_3), X60Qii_4, mem.i32((br_0 + 40)), mem.i32((br_0 + 44)));
                        }
                      }
                      inc_1_I6wjjge_cmdqs323n1(X60Qlf_31);
                    }
                  }
                }
              }
            }
            endTree_0_nifjp9lau1(b_35);
            var X60Qx_414 = emitFieldBody_0_parq39nt2(ps_50, b_35, bcolon_0, refIndent_1, mem.i32((br_0 + 40)), mem.i32((br_0 + 44)));
            i_24 = X60Qx_414;
            endTree_0_nifjp9lau1(b_35);
            eQdestroy_1_Iv9ij5i1_mat7cnfv21(vals_0);
          } else {
            var X60Qx_24 = allocFixed(8);
            nimStrWasMoved(X60Qx_24);
            var X60Qx_415 = eqQ_20_sysvq0asl((br_0 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1768711678);
              mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
              return _o;
            })());
            if (X60Qx_415) {
              nimStrDestroy(X60Qx_24);
              mem.copy(X60Qx_24, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1768711678);
                mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
                return _o;
              })(), 8);
            } else {
              nimStrDestroy(X60Qx_24);
              mem.copy(X60Qx_24, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1936483838);
                mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
                return _o;
              })(), 8);
            }
            addTree_0_nifjp9lau1(b_35, X60Qx_24);
            emitInfo_0_parq39nt2(ps_50, b_35, mem.i32((br_0 + 40)), mem.i32((br_0 + 44)), mem.i32((kw_4 + 40)), mem.i32((kw_4 + 44)), false);
            var X60Qx_416 = emitFieldBody_0_parq39nt2(ps_50, b_35, bcolon_0, refIndent_1, mem.i32((br_0 + 40)), mem.i32((br_0 + 44)));
            i_24 = X60Qx_416;
            endTree_0_nifjp9lau1(b_35);
            nimStrDestroy(X60Qx_24);
          }
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(br_0);
        } else {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_57);
          break;
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_57);
      }
    }
  }
  endTree_0_nifjp9lau1(b_35);
  result_27 = i_24;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_4);
  return result_27;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_4);
  return result_27;
}

function parseObjectWhen_0_parq39nt2(ps_51, b_36, whenIdx_0, defIndent_4, kl_3, kc_3) {
  whileStmtLabel_0: {
    var result_28;
    var kw_5 = allocFixed(72);
    mem.copy(kw_5, tok_0_parq39nt2(ps_51, whenIdx_0), 72);
    addTree_0_nifjp9lau1(b_36, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1701345278);
      mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_51, b_36, mem.i32((kw_5 + 40)), mem.i32((kw_5 + 44)), kl_3, kc_3, false);
    var i_25 = whenIdx_0;
    var refIndent_2 = mem.i32((kw_5 + 44));
    {
      while (true) {
        var X60Qx_93;
        var X60Qx_94;
        var X60Qtmp_63 = allocFixed(72);
        mem.copy(X60Qtmp_63, tok_0_parq39nt2(ps_51, i_25), 72);
        if ((mem.u8At(X60Qtmp_63) === 2)) {
          var X60Qtmp_64 = allocFixed(72);
          mem.copy(X60Qtmp_64, tok_0_parq39nt2(ps_51, i_25), 72);
          X60Qx_94 = (refIndent_2 <= mem.i32((X60Qtmp_64 + 52)));
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_64);
        } else {
          X60Qx_94 = false;
        }
        if (X60Qx_94) {
          var X60Qx_95;
          var X60Qx_96;
          var X60Qtmp_65 = allocFixed(72);
          mem.copy(X60Qtmp_65, tok_0_parq39nt2(ps_51, i_25), 72);
          var X60Qx_417 = eqQ_20_sysvq0asl((X60Qtmp_65 + 4), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1701345278);
            mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
            return _o;
          })());
          if (X60Qx_417) {
            X60Qx_96 = true;
          } else {
            var X60Qtmp_66 = allocFixed(72);
            mem.copy(X60Qtmp_66, tok_0_parq39nt2(ps_51, i_25), 72);
            var X60Qx_418 = eqQ_20_sysvq0asl((X60Qtmp_66 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1768711678);
              mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
              return _o;
            })());
            X60Qx_96 = X60Qx_418;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_66);
          }
          if (X60Qx_96) {
            X60Qx_95 = true;
          } else {
            var X60Qtmp_67 = allocFixed(72);
            mem.copy(X60Qtmp_67, tok_0_parq39nt2(ps_51, i_25), 72);
            var X60Qx_419 = eqQ_20_sysvq0asl((X60Qtmp_67 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1936483838);
              mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
              return _o;
            })());
            X60Qx_95 = X60Qx_419;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_67);
          }
          X60Qx_93 = X60Qx_95;
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_65);
        } else {
          X60Qx_93 = false;
        }
        if (X60Qx_93) {
          var br_1 = allocFixed(72);
          mem.copy(br_1, tok_0_parq39nt2(ps_51, i_25), 72);
          var bhi_1 = lineEnd_0_parq39nt2(ps_51, i_25);
          var bcolon_1 = findColon_0_parq39nt2(ps_51, i_25, bhi_1);
          var X60Qx_420 = eqQ_20_sysvq0asl((br_1 + 4), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1936483838);
            mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
            return _o;
          })());
          if (X60Qx_420) {
            addTree_0_nifjp9lau1(b_36, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1936483838);
              mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_51, b_36, mem.i32((br_1 + 40)), mem.i32((br_1 + 44)), mem.i32((kw_5 + 40)), mem.i32((kw_5 + 44)), false);
            var X60Qx_421 = emitFieldBody_0_parq39nt2(ps_51, b_36, bcolon_1, refIndent_2, mem.i32((br_1 + 40)), mem.i32((br_1 + 44)));
            i_25 = X60Qx_421;
            endTree_0_nifjp9lau1(b_36);
          } else {
            var ct_1 = allocFixed(72);
            mem.copy(ct_1, tok_0_parq39nt2(ps_51, ((i_25 + 1) | 0)), 72);
            addTree_0_nifjp9lau1(b_36, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1768711678);
              mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_51, b_36, mem.i32((ct_1 + 40)), mem.i32((ct_1 + 44)), mem.i32((kw_5 + 40)), mem.i32((kw_5 + 44)), false);
            if ((((i_25 + 1) | 0) < bcolon_1)) {
              parseExprRange_1_parq39nt2(ps_51, b_36, ((i_25 + 1) | 0), bcolon_1, mem.i32((ct_1 + 40)), mem.i32((ct_1 + 44)));
            } else {
              addEmpty_0_nifjp9lau1(b_36, 1);
            }
            var X60Qx_422 = emitFieldBody_0_parq39nt2(ps_51, b_36, bcolon_1, refIndent_2, mem.i32((ct_1 + 40)), mem.i32((ct_1 + 44)));
            i_25 = X60Qx_422;
            endTree_0_nifjp9lau1(b_36);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(ct_1);
          }
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(br_1);
        } else {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_63);
          break;
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_63);
      }
    }
  }
  endTree_0_nifjp9lau1(b_36);
  result_28 = i_25;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_5);
  return result_28;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_5);
  return result_28;
}

function parseObject_1_parq39nt2(ps_52, b_37, objIdx_1, defIndent_5, pl_32, pc_32) {
  whileStmtLabel_0: {
    var result_29;
    var kw_6 = allocFixed(72);
    mem.copy(kw_6, tok_0_parq39nt2(ps_52, objIdx_1), 72);
    addTree_0_nifjp9lau1(b_37, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1784836094);
      mem.setU32((_o + 4), strlit_0_I973692718279674627_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_52, b_37, mem.i32((kw_6 + 40)), mem.i32((kw_6 + 44)), pl_32, pc_32, false);
    var objLineEnd_0 = lineEnd_0_parq39nt2(ps_52, objIdx_1);
    var i_26 = allocFixed(4);
    mem.setI32(i_26, ((objIdx_1 + 1) | 0));
    var X60Qx_97;
    var X60Qx_98;
    if ((mem.i32(i_26) < objLineEnd_0)) {
      var X60Qtmp_68 = allocFixed(72);
      mem.copy(X60Qtmp_68, tok_0_parq39nt2(ps_52, mem.i32(i_26)), 72);
      X60Qx_98 = (mem.u8At(X60Qtmp_68) === 2);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_68);
    } else {
      X60Qx_98 = false;
    }
    if (X60Qx_98) {
      var X60Qtmp_69 = allocFixed(72);
      mem.copy(X60Qtmp_69, tok_0_parq39nt2(ps_52, mem.i32(i_26)), 72);
      var X60Qx_423 = eqQ_20_sysvq0asl((X60Qtmp_69 + 4), (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 6713090);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      X60Qx_97 = X60Qx_423;
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_69);
    } else {
      X60Qx_97 = false;
    }
    if (X60Qx_97) {
      inc_1_I6wjjge_cmdqs323n1(i_26);
      if ((mem.i32(i_26) < objLineEnd_0)) {
        var pt_0 = allocFixed(72);
        mem.copy(pt_0, tok_0_parq39nt2(ps_52, mem.i32(i_26)), 72);
        addIdent_0_nifjp9lau1(b_37, (pt_0 + 4));
        emitInfo_0_parq39nt2(ps_52, b_37, mem.i32((pt_0 + 40)), mem.i32((pt_0 + 44)), mem.i32((kw_6 + 40)), mem.i32((kw_6 + 44)), false);
        inc_1_I6wjjge_cmdqs323n1(i_26);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(pt_0);
      }
    } else {
      addEmpty_0_nifjp9lau1(b_37, 1);
    }
    var fi_1 = allocFixed(4);
    mem.setI32(fi_1, objLineEnd_0);
    {
      while (true) {
        var X60Qx_99;
        var X60Qtmp_70 = allocFixed(72);
        mem.copy(X60Qtmp_70, tok_0_parq39nt2(ps_52, mem.i32(fi_1)), 72);
        if ((!(mem.u8At(X60Qtmp_70) === 0))) {
          var X60Qtmp_71 = allocFixed(72);
          mem.copy(X60Qtmp_71, tok_0_parq39nt2(ps_52, mem.i32(fi_1)), 72);
          X60Qx_99 = (defIndent_5 < mem.i32((X60Qtmp_71 + 52)));
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_71);
        } else {
          X60Qx_99 = false;
        }
        if (X60Qx_99) {
          continueLabel_1: {
            {
              var X60Qtmp_72 = allocFixed(72);
              mem.copy(X60Qtmp_72, tok_0_parq39nt2(ps_52, mem.i32(fi_1)), 72);
              if ((mem.u8At(X60Qtmp_72) === 20)) {
                inc_1_I6wjjge_cmdqs323n1(fi_1);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_72);
                break continueLabel_1;
              }
              var X60Qx_100;
              var X60Qtmp_73 = allocFixed(72);
              mem.copy(X60Qtmp_73, tok_0_parq39nt2(ps_52, mem.i32(fi_1)), 72);
              if ((mem.u8At(X60Qtmp_73) === 2)) {
                var X60Qtmp_74 = allocFixed(72);
                mem.copy(X60Qtmp_74, tok_0_parq39nt2(ps_52, mem.i32(fi_1)), 72);
                var X60Qx_424 = eqQ_20_sysvq0asl((X60Qtmp_74 + 4), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1935762430);
                  mem.setU32((_o + 4), strlit_0_I4956278306908871092_parq39nt2);
                  return _o;
                })());
                X60Qx_100 = X60Qx_424;
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_74);
              } else {
                X60Qx_100 = false;
              }
              if (X60Qx_100) {
                var X60Qx_425 = parseObjectCase_0_parq39nt2(ps_52, b_37, mem.i32(fi_1), defIndent_5, mem.i32((kw_6 + 40)), mem.i32((kw_6 + 44)));
                mem.setI32(fi_1, X60Qx_425);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_73);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_72);
                break continueLabel_1;
              }
              var X60Qx_101;
              var X60Qtmp_75 = allocFixed(72);
              mem.copy(X60Qtmp_75, tok_0_parq39nt2(ps_52, mem.i32(fi_1)), 72);
              if ((mem.u8At(X60Qtmp_75) === 2)) {
                var X60Qtmp_76 = allocFixed(72);
                mem.copy(X60Qtmp_76, tok_0_parq39nt2(ps_52, mem.i32(fi_1)), 72);
                var X60Qx_426 = eqQ_20_sysvq0asl((X60Qtmp_76 + 4), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1701345278);
                  mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
                  return _o;
                })());
                X60Qx_101 = X60Qx_426;
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_76);
              } else {
                X60Qx_101 = false;
              }
              if (X60Qx_101) {
                var X60Qx_427 = parseObjectWhen_0_parq39nt2(ps_52, b_37, mem.i32(fi_1), defIndent_5, mem.i32((kw_6 + 40)), mem.i32((kw_6 + 44)));
                mem.setI32(fi_1, X60Qx_427);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_75);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_73);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_72);
                break continueLabel_1;
              }
              var lineHi_1 = lineEnd_0_parq39nt2(ps_52, mem.i32(fi_1));
              emitFieldLine_0_parq39nt2(ps_52, b_37, mem.i32(fi_1), lineHi_1, mem.i32((kw_6 + 40)), mem.i32((kw_6 + 44)));
              mem.setI32(fi_1, lineHi_1);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_75);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_73);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_72);
            }
          }
        } else {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_70);
          break;
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_70);
      }
    }
  }
  endTree_0_nifjp9lau1(b_37);
  result_29 = mem.i32(fi_1);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_6);
  return result_29;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_6);
  return result_29;
}

function parseEnum_1_parq39nt2(ps_53, b_38, enumIdx_1, defIndent_6, pl_33, pc_33) {
  forStmtLabel_2: {
    whileStmtLabel_0: {
      var result_30;
      var kw_7 = allocFixed(72);
      mem.copy(kw_7, tok_0_parq39nt2(ps_53, enumIdx_1), 72);
      addTree_0_nifjp9lau1(b_38, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1970169342);
        mem.setU32((_o + 4), strlit_0_I10462096440466995513_parq39nt2);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_53, b_38, mem.i32((kw_7 + 40)), mem.i32((kw_7 + 44)), pl_33, pc_33, false);
      addEmpty_0_nifjp9lau1(b_38, 1);
      var lo_29 = lineEnd_0_parq39nt2(ps_53, enumIdx_1);
      var startLo_0 = ((enumIdx_1 + 1) | 0);
      if ((startLo_0 < lo_29)) {
        lo_29 = startLo_0;
      }
      var hi_31 = allocFixed(4);
      mem.setI32(hi_31, lo_29);
      {
        while (true) {
          var X60Qx_102;
          var X60Qtmp_77 = allocFixed(72);
          mem.copy(X60Qtmp_77, tok_0_parq39nt2(ps_53, mem.i32(hi_31)), 72);
          if ((!(mem.u8At(X60Qtmp_77) === 0))) {
            var X60Qx_103;
            var X60Qtmp_78 = allocFixed(72);
            mem.copy(X60Qtmp_78, tok_0_parq39nt2(ps_53, mem.i32(hi_31)), 72);
            if ((defIndent_6 < mem.i32((X60Qtmp_78 + 52)))) {
              X60Qx_103 = true;
            } else {
              var X60Qtmp_79 = allocFixed(72);
              mem.copy(X60Qtmp_79, tok_0_parq39nt2(ps_53, mem.i32(hi_31)), 72);
              X60Qx_103 = (mem.i32((X60Qtmp_79 + 52)) < 0);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_79);
            }
            X60Qx_102 = X60Qx_103;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_78);
          } else {
            X60Qx_102 = false;
          }
          if (X60Qx_102) {
            inc_1_I6wjjge_cmdqs323n1(hi_31);
          } else {
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_77);
            break;
          }
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_77);
        }
      }
    }
    var iLos_0 = allocFixed(8);
    mem.copy(iLos_0, newSeqUninit_0_Iggfvwp_mat7cnfv21(0), 8);
    var iHis_0 = allocFixed(8);
    mem.copy(iHis_0, newSeqUninit_0_Iggfvwp_mat7cnfv21(0), 8);
    if ((lo_29 < mem.i32(hi_31))) {
      whileStmtLabel_1: {
        var curLo_0 = lo_29;
        var d_3 = allocFixed(4);
        mem.setI32(d_3, 0);
        var k_11 = allocFixed(4);
        mem.setI32(k_11, lo_29);
        {
          while ((mem.i32(k_11) < mem.i32(hi_31))) {
            var t_18 = allocFixed(72);
            mem.copy(t_18, tok_0_parq39nt2(ps_53, mem.i32(k_11)), 72);
            var X60Qx_428 = isOpenBracket_0_parq39nt2(mem.u8At(t_18));
            if (X60Qx_428) {
              inc_1_I6wjjge_cmdqs323n1(d_3);
            } else {
              var X60Qx_429 = isCloseBracket_0_parq39nt2(mem.u8At(t_18));
              if (X60Qx_429) {
                if ((0 < mem.i32(d_3))) {
                  dec_1_I0nzoz91_envto7w6l1(d_3);
                }
              } else {
                var X60Qx_430;
                if ((mem.i32(d_3) === 0)) {
                  X60Qx_430 = (mem.u8At(t_18) === 16);
                } else {
                  X60Qx_430 = false;
                }
                if (X60Qx_430) {
                  add_0_I8kd4i4_parq39nt2(iLos_0, curLo_0);
                  add_0_I8kd4i4_parq39nt2(iHis_0, mem.i32(k_11));
                  curLo_0 = ((mem.i32(k_11) + 1) | 0);
                } else {
                  var X60Qx_104;
                  var X60Qx_431;
                  var X60Qx_432;
                  if ((mem.i32(d_3) === 0)) {
                    X60Qx_432 = (curLo_0 < mem.i32(k_11));
                  } else {
                    X60Qx_432 = false;
                  }
                  if (X60Qx_432) {
                    X60Qx_431 = (0 <= mem.i32((t_18 + 52)));
                  } else {
                    X60Qx_431 = false;
                  }
                  if (X60Qx_431) {
                    var X60Qtmp_80 = allocFixed(72);
                    mem.copy(X60Qtmp_80, tok_0_parq39nt2(ps_53, ((mem.i32(k_11) - 1) | 0)), 72);
                    X60Qx_104 = (!(mem.u8At(X60Qtmp_80) === 16));
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_80);
                  } else {
                    X60Qx_104 = false;
                  }
                  if (X60Qx_104) {
                    add_0_I8kd4i4_parq39nt2(iLos_0, curLo_0);
                    add_0_I8kd4i4_parq39nt2(iHis_0, mem.i32(k_11));
                    curLo_0 = mem.i32(k_11);
                  }
                }
              }
            }
            inc_1_I6wjjge_cmdqs323n1(k_11);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_18);
          }
        }
      }
      if ((curLo_0 < mem.i32(hi_31))) {
        add_0_I8kd4i4_parq39nt2(iLos_0, curLo_0);
        add_0_I8kd4i4_parq39nt2(iHis_0, mem.i32(hi_31));
      }
    }
    {
      whileStmtLabel_3: {
        var X60Qlf_32 = 0;
        var X60Qlf_33 = len_3_I0v1j8d_parq39nt2(iLos_0);
        var X60Qlf_34 = allocFixed(4);
        mem.setI32(X60Qlf_34, X60Qlf_32);
        {
          while ((mem.i32(X60Qlf_34) < X60Qlf_33)) {
            {
              continueLabel_4: {
                {
                  var X60Qx_433 = getQ_7_Ir8kccm_parq39nt2(iLos_0, mem.i32(X60Qlf_34));
                  var X60Qii_5 = allocFixed(4);
                  mem.setI32(X60Qii_5, mem.i32(X60Qx_433));
                  var X60Qx_434 = getQ_7_Ir8kccm_parq39nt2(iHis_0, mem.i32(X60Qlf_34));
                  var X60Qii_6 = allocFixed(4);
                  mem.setI32(X60Qii_6, mem.i32(X60Qx_434));
                  if ((mem.i32(X60Qii_6) <= mem.i32(X60Qii_5))) {
                    break continueLabel_4;
                  }
                  var X60Qii_7 = allocFixed(4);
                  mem.setI32(X60Qii_7, mem.i32(X60Qii_5));
                  var X60Qii_8 = allocFixed(72);
                  mem.copy(X60Qii_8, tok_0_parq39nt2(ps_53, mem.i32(X60Qii_7)), 72);
                  if ((!(mem.u8At(X60Qii_8) === 1))) {
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_8);
                    break continueLabel_4;
                  }
                  inc_1_I6wjjge_cmdqs323n1(X60Qii_7);
                  var X60Qii_9 = allocFixed(4);
                  mem.setI32(X60Qii_9, -1);
                  var X60Qii_10 = -1;
                  var X60Qx_105;
                  if ((mem.i32(X60Qii_7) < mem.i32(X60Qii_6))) {
                    var X60Qtmp_81 = allocFixed(72);
                    mem.copy(X60Qtmp_81, tok_0_parq39nt2(ps_53, mem.i32(X60Qii_7)), 72);
                    X60Qx_105 = (mem.u8At(X60Qtmp_81) === 14);
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_81);
                  } else {
                    X60Qx_105 = false;
                  }
                  if (X60Qx_105) {
                    mem.setI32(X60Qii_9, mem.i32(X60Qii_7));
                    var X60Qx_435 = matchClose_0_parq39nt2(ps_53, mem.i32(X60Qii_7));
                    X60Qii_10 = X60Qx_435;
                    mem.setI32(X60Qii_7, ((X60Qii_10 + 1) | 0));
                  }
                  var X60Qii_11 = -1;
                  var X60Qx_106;
                  var X60Qx_107;
                  if ((mem.i32(X60Qii_7) < mem.i32(X60Qii_6))) {
                    var X60Qtmp_82 = allocFixed(72);
                    mem.copy(X60Qtmp_82, tok_0_parq39nt2(ps_53, mem.i32(X60Qii_7)), 72);
                    X60Qx_107 = (mem.u8At(X60Qtmp_82) === 9);
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_82);
                  } else {
                    X60Qx_107 = false;
                  }
                  if (X60Qx_107) {
                    var X60Qtmp_83 = allocFixed(72);
                    mem.copy(X60Qtmp_83, tok_0_parq39nt2(ps_53, mem.i32(X60Qii_7)), 72);
                    var X60Qx_436 = eqQ_20_sysvq0asl((X60Qtmp_83 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 15617);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                    X60Qx_106 = X60Qx_436;
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_83);
                  } else {
                    X60Qx_106 = false;
                  }
                  if (X60Qx_106) {
                    X60Qii_11 = ((mem.i32(X60Qii_7) + 1) | 0);
                  }
                  var X60Qx_25 = allocFixed(72);
                  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_25);
                  if ((0 <= X60Qii_11)) {
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_25);
                    var X60Qx_437 = allocFixed(72);
                    mem.copy(X60Qx_437, tok_0_parq39nt2(ps_53, X60Qii_11), 72);
                    mem.copy(X60Qx_25, X60Qx_437, 72);
                  } else {
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_25);
                    var X60Qx_438 = allocFixed(72);
                    mem.copy(X60Qx_438, eQdupQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_8), 72);
                    mem.copy(X60Qx_25, X60Qx_438, 72);
                  }
                  var X60Qii_12 = allocFixed(72);
                  mem.copy(X60Qii_12, X60Qx_25, 72);
                  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_25);
                  addTree_0_nifjp9lau1(b_38, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1818650110);
                    mem.setU32((_o + 4), strlit_0_I2171368188661376471_parq39nt2);
                    return _o;
                  })());
                  emitInfo_0_parq39nt2(ps_53, b_38, mem.i32((X60Qii_12 + 40)), mem.i32((X60Qii_12 + 44)), mem.i32((kw_7 + 40)), mem.i32((kw_7 + 44)), false);
                  addIdent_0_nifjp9lau1(b_38, (X60Qii_8 + 4));
                  emitInfo_0_parq39nt2(ps_53, b_38, mem.i32((X60Qii_8 + 40)), mem.i32((X60Qii_8 + 44)), mem.i32((X60Qii_12 + 40)), mem.i32((X60Qii_12 + 44)), false);
                  addEmpty_0_nifjp9lau1(b_38, 1);
                  emitPragmaSlot_0_parq39nt2(ps_53, b_38, mem.i32(X60Qii_9), X60Qii_10, mem.i32((X60Qii_12 + 40)), mem.i32((X60Qii_12 + 44)));
                  addEmpty_0_nifjp9lau1(b_38, 1);
                  if ((0 <= X60Qii_11)) {
                    parseExprRange_1_parq39nt2(ps_53, b_38, X60Qii_11, mem.i32(X60Qii_6), mem.i32((X60Qii_12 + 40)), mem.i32((X60Qii_12 + 44)));
                  } else {
                    addEmpty_0_nifjp9lau1(b_38, 1);
                  }
                  endTree_0_nifjp9lau1(b_38);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_12);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_25);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_8);
                }
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_34);
          }
        }
      }
    }
  }
  endTree_0_nifjp9lau1(b_38);
  result_30 = mem.i32(hi_31);
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(iHis_0);
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(iLos_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_7);
  return result_30;
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(iHis_0);
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(iLos_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_7);
  return result_30;
}

function parseConcept_0_parq39nt2(ps_54, b_39, conceptIdx_0, defIndent_7, pl_34, pc_34) {
  whileStmtLabel_0: {
    var result_31;
    var kw_8 = allocFixed(72);
    mem.copy(kw_8, tok_0_parq39nt2(ps_54, conceptIdx_0), 72);
    addTree_0_nifjp9lau1(b_39, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1852793854);
      mem.setU32((_o + 4), strlit_0_I2544717250931810611_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_54, b_39, mem.i32((kw_8 + 40)), mem.i32((kw_8 + 44)), pl_34, pc_34, false);
    var hi_32 = lineEnd_0_parq39nt2(ps_54, conceptIdx_0);
    addTree_0_nifjp9lau1(b_39, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1836348414);
      mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
      return _o;
    })());
    var pfirst_0 = allocFixed(72);
    mem.copy(pfirst_0, tok_0_parq39nt2(ps_54, ((conceptIdx_0 + 1) | 0)), 72);
    emitInfo_0_parq39nt2(ps_54, b_39, mem.i32((pfirst_0 + 40)), mem.i32((pfirst_0 + 44)), mem.i32((kw_8 + 40)), mem.i32((kw_8 + 44)), false);
    var pi_0 = ((conceptIdx_0 + 1) | 0);
    {
      while (true) {
        var X60Qx_108;
        if ((pi_0 < hi_32)) {
          var X60Qtmp_84 = allocFixed(72);
          mem.copy(X60Qtmp_84, tok_0_parq39nt2(ps_54, pi_0), 72);
          X60Qx_108 = (!(mem.u8At(X60Qtmp_84) === 0));
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_84);
        } else {
          X60Qx_108 = false;
        }
        if (X60Qx_108) {
          var X60Qx_439 = parseStmt_1_parq39nt2(ps_54, b_39, pi_0, mem.i32((pfirst_0 + 40)), mem.i32((pfirst_0 + 44)), hi_32);
          pi_0 = X60Qx_439;
        } else {
          break;
        }
      }
    }
  }
  endTree_0_nifjp9lau1(b_39);
  addEmpty_0_nifjp9lau1(b_39, 1);
  addEmpty_0_nifjp9lau1(b_39, 1);
  var bodyFirst_0 = allocFixed(72);
  mem.copy(bodyFirst_0, tok_0_parq39nt2(ps_54, hi_32), 72);
  var X60Qx_440;
  if ((!(mem.u8At(bodyFirst_0) === 0))) {
    X60Qx_440 = (defIndent_7 < mem.i32((bodyFirst_0 + 52)));
  } else {
    X60Qx_440 = false;
  }
  if (X60Qx_440) {
    whileStmtLabel_1: {
      addTree_0_nifjp9lau1(b_39, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1836348414);
        mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_54, b_39, mem.i32((bodyFirst_0 + 40)), mem.i32((bodyFirst_0 + 44)), mem.i32((kw_8 + 40)), mem.i32((kw_8 + 44)), false);
      var i_27 = hi_32;
      var bodyRef_0 = ((mem.i32((bodyFirst_0 + 52)) - 1) | 0);
      {
        while (true) {
          var X60Qx_109;
          var X60Qtmp_85 = allocFixed(72);
          mem.copy(X60Qtmp_85, tok_0_parq39nt2(ps_54, i_27), 72);
          if ((!(mem.u8At(X60Qtmp_85) === 0))) {
            var X60Qtmp_86 = allocFixed(72);
            mem.copy(X60Qtmp_86, tok_0_parq39nt2(ps_54, i_27), 72);
            X60Qx_109 = (bodyRef_0 < mem.i32((X60Qtmp_86 + 52)));
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_86);
          } else {
            X60Qx_109 = false;
          }
          if (X60Qx_109) {
            var X60Qx_441 = parseStmt_1_parq39nt2(ps_54, b_39, i_27, mem.i32((bodyFirst_0 + 40)), mem.i32((bodyFirst_0 + 44)), -1);
            i_27 = X60Qx_441;
          } else {
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_85);
            break;
          }
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_85);
        }
      }
    }
    endTree_0_nifjp9lau1(b_39);
    result_31 = i_27;
  } else {
    addEmpty_0_nifjp9lau1(b_39, 1);
    result_31 = hi_32;
  }
  endTree_0_nifjp9lau1(b_39);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(bodyFirst_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(pfirst_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_8);
  return result_31;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(bodyFirst_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(pfirst_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_8);
  return result_31;
}

function parseTypeDef_1_parq39nt2(ps_55, b_40, nameIdx_1, typeKwCol_1, pl_35, pc_35) {
  X60Qlab_0: {
    var result_32;
    var i_28 = allocFixed(4);
    mem.setI32(i_28, nameIdx_1);
    var nameTok_2 = allocFixed(72);
    mem.copy(nameTok_2, tok_0_parq39nt2(ps_55, nameIdx_1), 72);
    var hasExport_1 = allocFixed(1);
    mem.setU8(hasExport_1, false);
    var pragLo_3 = allocFixed(4);
    mem.setI32(pragLo_3, -1);
    var pragHi_3 = allocFixed(4);
    mem.setI32(pragHi_3, -1);
    var X60Qx_442 = len_3_Iefkljt1_lex3r1urc1(ps_55);
    splitFieldName_0_parq39nt2(ps_55, i_28, X60Qx_442, nameTok_2, hasExport_1, pragLo_3, pragHi_3);
    var genIdx_0 = -1;
    var X60Qx_110;
    var X60Qx_443 = len_3_Iefkljt1_lex3r1urc1(ps_55);
    if ((mem.i32(i_28) < X60Qx_443)) {
      var X60Qtmp_87 = allocFixed(72);
      mem.copy(X60Qtmp_87, tok_0_parq39nt2(ps_55, mem.i32(i_28)), 72);
      X60Qx_110 = (mem.u8At(X60Qtmp_87) === 12);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_87);
    } else {
      X60Qx_110 = false;
    }
    if (X60Qx_110) {
      genIdx_0 = mem.i32(i_28);
      var X60Qx_444 = matchClose_0_parq39nt2(ps_55, mem.i32(i_28));
      mem.setI32(i_28, ((X60Qx_444 + 1) | 0));
    }
    var eqIdx_0 = -1;
    {
      whileStmtLabel_1: {
        var k_12 = allocFixed(4);
        mem.setI32(k_12, mem.i32(i_28));
        var le_0 = lineEnd_0_parq39nt2(ps_55, nameIdx_1);
        {
          while ((mem.i32(k_12) < le_0)) {
            var X60Qx_111;
            var X60Qtmp_88 = allocFixed(72);
            mem.copy(X60Qtmp_88, tok_0_parq39nt2(ps_55, mem.i32(k_12)), 72);
            if ((mem.u8At(X60Qtmp_88) === 9)) {
              var X60Qtmp_89 = allocFixed(72);
              mem.copy(X60Qtmp_89, tok_0_parq39nt2(ps_55, mem.i32(k_12)), 72);
              var X60Qx_445 = eqQ_20_sysvq0asl((X60Qtmp_89 + 4), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 15617);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              X60Qx_111 = X60Qx_445;
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_89);
            } else {
              X60Qx_111 = false;
            }
            if (X60Qx_111) {
              eqIdx_0 = mem.i32(k_12);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_88);
              break whileStmtLabel_1;
            }
            inc_1_I6wjjge_cmdqs323n1(k_12);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_88);
          }
        }
      }
    }
  }
  var X60Qx_26 = allocFixed(72);
  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_26);
  if ((0 <= eqIdx_0)) {
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_26);
    var X60Qx_446 = allocFixed(72);
    mem.copy(X60Qx_446, tok_0_parq39nt2(ps_55, eqIdx_0), 72);
    mem.copy(X60Qx_26, X60Qx_446, 72);
  } else {
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_26);
    var X60Qx_447 = allocFixed(72);
    mem.copy(X60Qx_447, eQdupQ_SX54oken0tok9e79hf_0_tok9e79hf(nameTok_2), 72);
    mem.copy(X60Qx_26, X60Qx_447, 72);
  }
  var eqTok_0 = allocFixed(72);
  mem.copy(eqTok_0, X60Qx_26, 72);
  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_26);
  addTree_0_nifjp9lau1(b_40, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1887007998);
    mem.setU32((_o + 4), strlit_0_I13413619771642637377_parq39nt2);
    return _o;
  })());
  emitInfo_0_parq39nt2(ps_55, b_40, mem.i32((eqTok_0 + 40)), mem.i32((eqTok_0 + 44)), pl_35, pc_35, false);
  addIdent_0_nifjp9lau1(b_40, (nameTok_2 + 4));
  emitInfo_0_parq39nt2(ps_55, b_40, mem.i32((nameTok_2 + 40)), mem.i32((nameTok_2 + 44)), mem.i32((eqTok_0 + 40)), mem.i32((eqTok_0 + 44)), false);
  if (mem.u8At(hasExport_1)) {
    addRaw_0_nifjp9lau1(b_40, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 7872514);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
  } else {
    addEmpty_0_nifjp9lau1(b_40, 1);
  }
  if ((0 <= genIdx_0)) {
    var X60Qx_448 = parseGenerics_1_parq39nt2(ps_55, b_40, genIdx_0, mem.i32((eqTok_0 + 40)), mem.i32((eqTok_0 + 44)));
  } else {
    addEmpty_0_nifjp9lau1(b_40, 1);
  }
  emitPragmaSlot_0_parq39nt2(ps_55, b_40, mem.i32(pragLo_3), mem.i32(pragHi_3), mem.i32((eqTok_0 + 40)), mem.i32((eqTok_0 + 44)));
  var X60Qx_27;
  if ((0 <= mem.i32((nameTok_2 + 52)))) {
    X60Qx_27 = mem.i32((nameTok_2 + 52));
  } else {
    X60Qx_27 = typeKwCol_1;
  }
  var defIndent_8 = X60Qx_27;
  var resultIdx_0 = lineEnd_0_parq39nt2(ps_55, nameIdx_1);
  if ((0 <= eqIdx_0)) {
    var rhsIdx_0 = ((eqIdx_0 + 1) | 0);
    var r_1 = allocFixed(72);
    mem.copy(r_1, tok_0_parq39nt2(ps_55, rhsIdx_0), 72);
    var X60Qx_449;
    if ((mem.u8At(r_1) === 2)) {
      var X60Qx_450 = eqQ_20_sysvq0asl((r_1 + 4), (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1784836094);
        mem.setU32((_o + 4), strlit_0_I973692718279674627_parq39nt2);
        return _o;
      })());
      X60Qx_449 = X60Qx_450;
    } else {
      X60Qx_449 = false;
    }
    if (X60Qx_449) {
      var X60Qx_451 = parseObject_1_parq39nt2(ps_55, b_40, rhsIdx_0, defIndent_8, mem.i32((eqTok_0 + 40)), mem.i32((eqTok_0 + 44)));
      resultIdx_0 = X60Qx_451;
    } else {
      var X60Qx_452;
      if ((mem.u8At(r_1) === 2)) {
        var X60Qx_453 = eqQ_20_sysvq0asl((r_1 + 4), (() => {
          var _o = allocFixed(8);
          mem.setU32(_o, 1970169342);
          mem.setU32((_o + 4), strlit_0_I10462096440466995513_parq39nt2);
          return _o;
        })());
        X60Qx_452 = X60Qx_453;
      } else {
        X60Qx_452 = false;
      }
      if (X60Qx_452) {
        var X60Qx_454 = parseEnum_1_parq39nt2(ps_55, b_40, rhsIdx_0, defIndent_8, mem.i32((eqTok_0 + 40)), mem.i32((eqTok_0 + 44)));
        resultIdx_0 = X60Qx_454;
      } else {
        var X60Qx_455;
        if ((mem.u8At(r_1) === 2)) {
          var X60Qx_456 = eqQ_20_sysvq0asl((r_1 + 4), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1852793854);
            mem.setU32((_o + 4), strlit_0_I2544717250931810611_parq39nt2);
            return _o;
          })());
          X60Qx_455 = X60Qx_456;
        } else {
          X60Qx_455 = false;
        }
        if (X60Qx_455) {
          var X60Qx_457 = parseConcept_0_parq39nt2(ps_55, b_40, rhsIdx_0, defIndent_8, mem.i32((eqTok_0 + 40)), mem.i32((eqTok_0 + 44)));
          resultIdx_0 = X60Qx_457;
        } else {
          var X60Qx_112;
          var X60Qx_113;
          var X60Qx_458;
          if ((mem.u8At(r_1) === 2)) {
            var X60Qx_459;
            var X60Qx_460 = eqQ_20_sysvq0asl((r_1 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1717924355);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            if (X60Qx_460) {
              X60Qx_459 = true;
            } else {
              var X60Qx_461 = eqQ_20_sysvq0asl((r_1 + 4), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1920233475);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              X60Qx_459 = X60Qx_461;
            }
            X60Qx_458 = X60Qx_459;
          } else {
            X60Qx_458 = false;
          }
          if (X60Qx_458) {
            var X60Qtmp_90 = allocFixed(72);
            mem.copy(X60Qtmp_90, tok_0_parq39nt2(ps_55, ((rhsIdx_0 + 1) | 0)), 72);
            X60Qx_113 = (mem.u8At(X60Qtmp_90) === 2);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_90);
          } else {
            X60Qx_113 = false;
          }
          if (X60Qx_113) {
            var X60Qtmp_91 = allocFixed(72);
            mem.copy(X60Qtmp_91, tok_0_parq39nt2(ps_55, ((rhsIdx_0 + 1) | 0)), 72);
            var X60Qx_462 = eqQ_20_sysvq0asl((X60Qtmp_91 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1784836094);
              mem.setU32((_o + 4), strlit_0_I973692718279674627_parq39nt2);
              return _o;
            })());
            X60Qx_112 = X60Qx_462;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_91);
          } else {
            X60Qx_112 = false;
          }
          if (X60Qx_112) {
            addTree_0_nifjp9lau1(b_40, (r_1 + 4));
            emitInfo_0_parq39nt2(ps_55, b_40, mem.i32((r_1 + 40)), mem.i32((r_1 + 44)), mem.i32((eqTok_0 + 40)), mem.i32((eqTok_0 + 44)), false);
            var X60Qx_463 = parseObject_1_parq39nt2(ps_55, b_40, ((rhsIdx_0 + 1) | 0), defIndent_8, mem.i32((r_1 + 40)), mem.i32((r_1 + 44)));
            resultIdx_0 = X60Qx_463;
            endTree_0_nifjp9lau1(b_40);
          } else {
            var hi_33 = lineEnd_0_parq39nt2(ps_55, rhsIdx_0);
            parseTypeRange_1_parq39nt2(ps_55, b_40, rhsIdx_0, hi_33, mem.i32((eqTok_0 + 40)), mem.i32((eqTok_0 + 44)));
            resultIdx_0 = hi_33;
          }
        }
      }
    }
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(r_1);
  } else {
    addEmpty_0_nifjp9lau1(b_40, 1);
  }
  endTree_0_nifjp9lau1(b_40);
  result_32 = resultIdx_0;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(eqTok_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_26);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nameTok_2);
  return result_32;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(eqTok_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qx_26);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nameTok_2);
  return result_32;
}

function parseTypeSection_1_parq39nt2(ps_56, b_41, kwIdx_3, pl_36, pc_36) {
  var result_33;
  var kw_9 = allocFixed(72);
  mem.copy(kw_9, tok_0_parq39nt2(ps_56, kwIdx_3), 72);
  var typeKwCol_2 = mem.i32((kw_9 + 44));
  var i_29 = ((kwIdx_3 + 1) | 0);
  var X60Qx_114;
  var X60Qtmp_92 = allocFixed(72);
  mem.copy(X60Qtmp_92, tok_0_parq39nt2(ps_56, i_29), 72);
  if ((!(mem.u8At(X60Qtmp_92) === 0))) {
    var X60Qtmp_93 = allocFixed(72);
    mem.copy(X60Qtmp_93, tok_0_parq39nt2(ps_56, i_29), 72);
    X60Qx_114 = (mem.i32((X60Qtmp_93 + 40)) === mem.i32((kw_9 + 40)));
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_93);
  } else {
    X60Qx_114 = false;
  }
  if (X60Qx_114) {
    var X60Qx_464 = parseTypeDef_1_parq39nt2(ps_56, b_41, i_29, typeKwCol_2, pl_36, pc_36);
    result_33 = X60Qx_464;
  } else {
    whileStmtLabel_0: {
      var j_3 = allocFixed(4);
      mem.setI32(j_3, i_29);
      {
        while (true) {
          var X60Qx_115;
          var X60Qtmp_94 = allocFixed(72);
          mem.copy(X60Qtmp_94, tok_0_parq39nt2(ps_56, mem.i32(j_3)), 72);
          if ((!(mem.u8At(X60Qtmp_94) === 0))) {
            var X60Qtmp_95 = allocFixed(72);
            mem.copy(X60Qtmp_95, tok_0_parq39nt2(ps_56, mem.i32(j_3)), 72);
            X60Qx_115 = (typeKwCol_2 < mem.i32((X60Qtmp_95 + 52)));
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_95);
          } else {
            X60Qx_115 = false;
          }
          if (X60Qx_115) {
            continueLabel_1: {
              {
                var X60Qtmp_96 = allocFixed(72);
                mem.copy(X60Qtmp_96, tok_0_parq39nt2(ps_56, mem.i32(j_3)), 72);
                if ((mem.u8At(X60Qtmp_96) === 20)) {
                  inc_1_I6wjjge_cmdqs323n1(j_3);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_96);
                  break continueLabel_1;
                }
                var X60Qx_465 = parseTypeDef_1_parq39nt2(ps_56, b_41, mem.i32(j_3), typeKwCol_2, pl_36, pc_36);
                mem.setI32(j_3, X60Qx_465);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_96);
              }
            }
          } else {
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_94);
            break;
          }
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_94);
        }
      }
    }
    result_33 = mem.i32(j_3);
  }
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_92);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_9);
  return result_33;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_92);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_9);
  return result_33;
}

function parseParams_1_parq39nt2(ps_57, b_42, lpIdx_1, pl_37, pc_37) {
  whileStmtLabel_0: {
    var result_34;
    var lp_2 = allocFixed(72);
    mem.copy(lp_2, tok_0_parq39nt2(ps_57, lpIdx_1), 72);
    var rpIdx_3 = matchClose_0_parq39nt2(ps_57, lpIdx_1);
    addTree_0_nifjp9lau1(b_42, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1918988542);
      mem.setU32((_o + 4), strlit_0_I5367917178860180580_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_57, b_42, mem.i32((lp_2 + 40)), mem.i32((lp_2 + 44)), pl_37, pc_37, false);
    var i_30 = allocFixed(4);
    mem.setI32(i_30, ((lpIdx_1 + 1) | 0));
    {
      while ((mem.i32(i_30) < rpIdx_3)) {
        forStmtLabel_3: {
          whileStmtLabel_1: {
            var names_3 = allocFixed(8);
            mem.copy(names_3, newSeqUninit_0_I28kyaw1_lex3r1urc1(0), 8);
            var exports_1 = allocFixed(8);
            mem.copy(exports_1, newSeqUninit_0_I5mozxi1_parq39nt2(0), 8);
            var firstPragLo_1 = -1;
            var firstPragHi_1 = -1;
            {
              while (true) {
                var X60Qx_116;
                if ((mem.i32(i_30) < rpIdx_3)) {
                  var X60Qx_117;
                  var X60Qtmp_97 = allocFixed(72);
                  mem.copy(X60Qtmp_97, tok_0_parq39nt2(ps_57, mem.i32(i_30)), 72);
                  if ((mem.u8At(X60Qtmp_97) === 1)) {
                    X60Qx_117 = true;
                  } else {
                    var X60Qtmp_98 = allocFixed(72);
                    mem.copy(X60Qtmp_98, tok_0_parq39nt2(ps_57, mem.i32(i_30)), 72);
                    X60Qx_117 = (mem.u8At(X60Qtmp_98) === 2);
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_98);
                  }
                  X60Qx_116 = X60Qx_117;
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_97);
                } else {
                  X60Qx_116 = false;
                }
                if (X60Qx_116) {
                  var nm_6 = allocFixed(72);
                  mem.copy(nm_6, tok_0_parq39nt2(ps_57, mem.i32(i_30)), 72);
                  var ex_1 = allocFixed(1);
                  mem.setU8(ex_1, false);
                  var pl2_1 = allocFixed(4);
                  mem.setI32(pl2_1, -1);
                  var ph2_1 = allocFixed(4);
                  mem.setI32(ph2_1, -1);
                  splitFieldName_0_parq39nt2(ps_57, i_30, rpIdx_3, nm_6, ex_1, pl2_1, ph2_1);
                  var X60Qtmp_99 = allocFixed(72);
                  mem.copy(X60Qtmp_99, nm_6, 72);
                  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(nm_6);
                  add_0_Icvfjtn_lex3r1urc1(names_3, X60Qtmp_99);
                  add_0_Irnc3p1_parq39nt2(exports_1, mem.u8At(ex_1));
                  var X60Qx_466;
                  if ((0 <= mem.i32(pl2_1))) {
                    X60Qx_466 = (firstPragLo_1 < 0);
                  } else {
                    X60Qx_466 = false;
                  }
                  if (X60Qx_466) {
                    firstPragLo_1 = mem.i32(pl2_1);
                    firstPragHi_1 = mem.i32(ph2_1);
                  }
                  var X60Qx_118;
                  if ((mem.i32(i_30) < rpIdx_3)) {
                    var X60Qtmp_100 = allocFixed(72);
                    mem.copy(X60Qtmp_100, tok_0_parq39nt2(ps_57, mem.i32(i_30)), 72);
                    X60Qx_118 = (mem.u8At(X60Qtmp_100) === 16);
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_100);
                  } else {
                    X60Qx_118 = false;
                  }
                  if (X60Qx_118) {
                    inc_1_I6wjjge_cmdqs323n1(i_30);
                  } else {
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nm_6);
                    break whileStmtLabel_1;
                  }
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nm_6);
                } else {
                  break;
                }
              }
            }
          }
          var tLo_2 = -1;
          var tHi_2 = rpIdx_3;
          var vLo_3 = -1;
          var X60Qx_119;
          if ((mem.i32(i_30) < rpIdx_3)) {
            var X60Qtmp_101 = allocFixed(72);
            mem.copy(X60Qtmp_101, tok_0_parq39nt2(ps_57, mem.i32(i_30)), 72);
            X60Qx_119 = (mem.u8At(X60Qtmp_101) === 18);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_101);
          } else {
            X60Qx_119 = false;
          }
          if (X60Qx_119) {
            inc_1_I6wjjge_cmdqs323n1(i_30);
            tLo_2 = mem.i32(i_30);
            var X60Qx_467 = typeExprEnd_0_parq39nt2(ps_57, mem.i32(i_30));
            tHi_2 = X60Qx_467;
            mem.setI32(i_30, tHi_2);
            var X60Qx_120;
            if ((mem.i32(i_30) < rpIdx_3)) {
              var X60Qtmp_102 = allocFixed(72);
              mem.copy(X60Qtmp_102, tok_0_parq39nt2(ps_57, mem.i32(i_30)), 72);
              X60Qx_120 = (mem.u8At(X60Qtmp_102) === 14);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_102);
            } else {
              X60Qx_120 = false;
            }
            if (X60Qx_120) {
              var X60Qx_468 = matchClose_0_parq39nt2(ps_57, mem.i32(i_30));
              mem.setI32(i_30, ((X60Qx_468 + 1) | 0));
              tHi_2 = mem.i32(i_30);
            }
          }
          var X60Qx_121;
          var X60Qx_122;
          if ((mem.i32(i_30) < rpIdx_3)) {
            var X60Qtmp_103 = allocFixed(72);
            mem.copy(X60Qtmp_103, tok_0_parq39nt2(ps_57, mem.i32(i_30)), 72);
            X60Qx_122 = (mem.u8At(X60Qtmp_103) === 9);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_103);
          } else {
            X60Qx_122 = false;
          }
          if (X60Qx_122) {
            var X60Qtmp_104 = allocFixed(72);
            mem.copy(X60Qtmp_104, tok_0_parq39nt2(ps_57, mem.i32(i_30)), 72);
            var X60Qx_469 = eqQ_20_sysvq0asl((X60Qtmp_104 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 15617);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            X60Qx_121 = X60Qx_469;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_104);
          } else {
            X60Qx_121 = false;
          }
          if (X60Qx_121) {
            whileStmtLabel_2: {
              inc_1_I6wjjge_cmdqs323n1(i_30);
              vLo_3 = mem.i32(i_30);
              var vd_0 = allocFixed(4);
              mem.setI32(vd_0, 0);
              {
                while ((mem.i32(i_30) < rpIdx_3)) {
                  var X60Qtmp_105 = allocFixed(72);
                  mem.copy(X60Qtmp_105, tok_0_parq39nt2(ps_57, mem.i32(i_30)), 72);
                  var k_13 = mem.u8At(X60Qtmp_105);
                  var X60Qx_470 = isOpenBracket_0_parq39nt2(k_13);
                  if (X60Qx_470) {
                    inc_1_I6wjjge_cmdqs323n1(vd_0);
                  } else {
                    var X60Qx_471 = isCloseBracket_0_parq39nt2(k_13);
                    if (X60Qx_471) {
                      if ((0 < mem.i32(vd_0))) {
                        dec_1_I0nzoz91_envto7w6l1(vd_0);
                      }
                    } else {
                      var X60Qx_472;
                      if ((mem.i32(vd_0) === 0)) {
                        var X60Qx_473;
                        if ((k_13 === 16)) {
                          X60Qx_473 = true;
                        } else {
                          X60Qx_473 = (k_13 === 17);
                        }
                        X60Qx_472 = X60Qx_473;
                      } else {
                        X60Qx_472 = false;
                      }
                      if (X60Qx_472) {
                        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_105);
                        break whileStmtLabel_2;
                      }
                    }
                  }
                  inc_1_I6wjjge_cmdqs323n1(i_30);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_105);
                }
              }
            }
          }
          var vHi_1 = mem.i32(i_30);
          {
            whileStmtLabel_4: {
              var X60Qlf_35 = 0;
              var X60Qlf_36 = len_3_Iefkljt1_lex3r1urc1(names_3);
              var X60Qlf_37 = allocFixed(4);
              mem.setI32(X60Qlf_37, X60Qlf_35);
              {
                while ((mem.i32(X60Qlf_37) < X60Qlf_36)) {
                  {
                    var X60Qx_474 = getQ_7_Ijq9cyk1_lex3r1urc1(names_3, mem.i32(X60Qlf_37));
                    var X60QconstRefTemp_0 = allocFixed(72);
                    mem.copy(X60QconstRefTemp_0, X60Qx_474, 72);
                    var X60Qii_5 = allocFixed(72);
                    mem.copy(X60Qii_5, eQdupQ_SX54oken0tok9e79hf_0_tok9e79hf(X60QconstRefTemp_0), 72);
                    addTree_0_nifjp9lau1(b_42, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1918988542);
                      mem.setU32((_o + 4), strlit_0_I9792473688321036479_parq39nt2);
                      return _o;
                    })());
                    emitInfo_0_parq39nt2(ps_57, b_42, mem.i32((X60Qii_5 + 40)), mem.i32((X60Qii_5 + 44)), mem.i32((lp_2 + 40)), mem.i32((lp_2 + 44)), false);
                    addIdent_0_nifjp9lau1(b_42, (X60Qii_5 + 4));
                    emitInfo_0_parq39nt2(ps_57, b_42, mem.i32((X60Qii_5 + 40)), mem.i32((X60Qii_5 + 44)), mem.i32((X60Qii_5 + 40)), mem.i32((X60Qii_5 + 44)), false);
                    var X60Qx_475 = getQ_7_Iul1no9_parq39nt2(exports_1, mem.i32(X60Qlf_37));
                    if (mem.u8At(X60Qx_475)) {
                      addRaw_0_nifjp9lau1(b_42, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 7872514);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                    } else {
                      addEmpty_0_nifjp9lau1(b_42, 1);
                    }
                    emitPragmaSlot_0_parq39nt2(ps_57, b_42, firstPragLo_1, firstPragHi_1, mem.i32((X60Qii_5 + 40)), mem.i32((X60Qii_5 + 44)));
                    if ((0 <= tLo_2)) {
                      parseTypeRange_1_parq39nt2(ps_57, b_42, tLo_2, tHi_2, mem.i32((X60Qii_5 + 40)), mem.i32((X60Qii_5 + 44)));
                    } else {
                      addEmpty_0_nifjp9lau1(b_42, 1);
                    }
                    if ((0 <= vLo_3)) {
                      parseExprRange_1_parq39nt2(ps_57, b_42, vLo_3, vHi_1, mem.i32((X60Qii_5 + 40)), mem.i32((X60Qii_5 + 44)));
                    } else {
                      addEmpty_0_nifjp9lau1(b_42, 1);
                    }
                    endTree_0_nifjp9lau1(b_42);
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_5);
                  }
                  inc_1_I6wjjge_cmdqs323n1(X60Qlf_37);
                }
              }
            }
          }
        }
        var X60Qx_123;
        if ((mem.i32(i_30) < rpIdx_3)) {
          var X60Qx_124;
          var X60Qtmp_106 = allocFixed(72);
          mem.copy(X60Qtmp_106, tok_0_parq39nt2(ps_57, mem.i32(i_30)), 72);
          if ((mem.u8At(X60Qtmp_106) === 16)) {
            X60Qx_124 = true;
          } else {
            var X60Qtmp_107 = allocFixed(72);
            mem.copy(X60Qtmp_107, tok_0_parq39nt2(ps_57, mem.i32(i_30)), 72);
            X60Qx_124 = (mem.u8At(X60Qtmp_107) === 17);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_107);
          }
          X60Qx_123 = X60Qx_124;
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_106);
        } else {
          X60Qx_123 = false;
        }
        if (X60Qx_123) {
          inc_1_I6wjjge_cmdqs323n1(i_30);
        }
        eQdestroy_1_I7a20g9_parq39nt2(exports_1);
        eQdestroy_1_Ie8xo6a1_lex3r1urc1(names_3);
      }
    }
  }
  endTree_0_nifjp9lau1(b_42);
  var j_4 = allocFixed(4);
  mem.setI32(j_4, ((rpIdx_3 + 1) | 0));
  var X60Qtmp_108 = allocFixed(72);
  mem.copy(X60Qtmp_108, tok_0_parq39nt2(ps_57, mem.i32(j_4)), 72);
  if ((mem.u8At(X60Qtmp_108) === 18)) {
    inc_1_I6wjjge_cmdqs323n1(j_4);
    var X60Qx_476 = parseType_1_parq39nt2(ps_57, b_42, mem.i32(j_4), mem.i32((lp_2 + 40)), mem.i32((lp_2 + 44)));
    mem.setI32(j_4, X60Qx_476);
  } else {
    addEmpty_0_nifjp9lau1(b_42, 1);
  }
  result_34 = mem.i32(j_4);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_108);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(lp_2);
  return result_34;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_108);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(lp_2);
  return result_34;
}

function parseRoutine_1_parq39nt2(ps_58, b_43, kwIdx_4, pl_38, pc_38, tag_2) {
  var result_35;
  var kw_10 = allocFixed(72);
  mem.copy(kw_10, tok_0_parq39nt2(ps_58, kwIdx_4), 72);
  addTree_0_nifjp9lau1(b_43, tag_2);
  emitInfo_0_parq39nt2(ps_58, b_43, mem.i32((kw_10 + 40)), mem.i32((kw_10 + 44)), pl_38, pc_38, false);
  var i_31 = allocFixed(4);
  mem.setI32(i_31, ((kwIdx_4 + 1) | 0));
  var name_0 = allocFixed(72);
  mem.copy(name_0, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
  var X60Qx_477;
  var X60Qx_478;
  var X60Qx_479;
  if ((mem.u8At(name_0) === 10)) {
    X60Qx_479 = true;
  } else {
    X60Qx_479 = (mem.u8At(name_0) === 12);
  }
  if (X60Qx_479) {
    X60Qx_478 = true;
  } else {
    X60Qx_478 = (mem.u8At(name_0) === 14);
  }
  if (X60Qx_478) {
    X60Qx_477 = true;
  } else {
    var X60Qx_480;
    if ((mem.u8At(name_0) === 9)) {
      var X60Qx_481 = eqQ_20_sysvq0asl((name_0 + 4), (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 15617);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      X60Qx_480 = X60Qx_481;
    } else {
      X60Qx_480 = false;
    }
    X60Qx_477 = X60Qx_480;
  }
  if (X60Qx_477) {
    addEmpty_0_nifjp9lau1(b_43, 1);
  } else {
    emitName_0_parq39nt2(ps_58, b_43, name_0, mem.i32((kw_10 + 40)), mem.i32((kw_10 + 44)));
    inc_1_I6wjjge_cmdqs323n1(i_31);
  }
  var X60Qx_125;
  var X60Qtmp_109 = allocFixed(72);
  mem.copy(X60Qtmp_109, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
  if ((mem.u8At(X60Qtmp_109) === 9)) {
    var X60Qtmp_110 = allocFixed(72);
    mem.copy(X60Qtmp_110, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
    var X60Qx_482 = eqQ_20_sysvq0asl((X60Qtmp_110 + 4), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 10753);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    X60Qx_125 = X60Qx_482;
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_110);
  } else {
    X60Qx_125 = false;
  }
  if (X60Qx_125) {
    inc_1_I6wjjge_cmdqs323n1(i_31);
    addRaw_0_nifjp9lau1(b_43, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 7872514);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
  } else {
    addEmpty_0_nifjp9lau1(b_43, 1);
  }
  addEmpty_0_nifjp9lau1(b_43, 1);
  var X60Qtmp_111 = allocFixed(72);
  mem.copy(X60Qtmp_111, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
  if ((mem.u8At(X60Qtmp_111) === 12)) {
    var X60Qx_483 = parseGenerics_1_parq39nt2(ps_58, b_43, mem.i32(i_31), mem.i32((kw_10 + 40)), mem.i32((kw_10 + 44)));
    mem.setI32(i_31, X60Qx_483);
  } else {
    addEmpty_0_nifjp9lau1(b_43, 1);
  }
  var X60Qtmp_112 = allocFixed(72);
  mem.copy(X60Qtmp_112, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
  if ((mem.u8At(X60Qtmp_112) === 10)) {
    var X60Qx_484 = parseParams_1_parq39nt2(ps_58, b_43, mem.i32(i_31), mem.i32((kw_10 + 40)), mem.i32((kw_10 + 44)));
    mem.setI32(i_31, X60Qx_484);
  } else {
    addEmpty_0_nifjp9lau1(b_43, 1);
    addEmpty_0_nifjp9lau1(b_43, 1);
  }
  var X60Qx_126;
  var X60Qtmp_113 = allocFixed(72);
  mem.copy(X60Qtmp_113, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
  if ((mem.u8At(X60Qtmp_113) === 14)) {
    var X60Qx_127;
    if ((!mem.u8At((ps_58 + 16)))) {
      X60Qx_127 = true;
    } else {
      var X60Qtmp_114 = allocFixed(72);
      mem.copy(X60Qtmp_114, tok_0_parq39nt2(ps_58, ((mem.i32(i_31) + 1) | 0)), 72);
      X60Qx_127 = (mem.u8At(X60Qtmp_114) === 19);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_114);
    }
    X60Qx_126 = X60Qx_127;
  } else {
    X60Qx_126 = false;
  }
  if (X60Qx_126) {
    var X60Qx_485 = parsePragmas_1_parq39nt2(ps_58, b_43, mem.i32(i_31), mem.i32((kw_10 + 40)), mem.i32((kw_10 + 44)));
    mem.setI32(i_31, X60Qx_485);
  } else {
    addEmpty_0_nifjp9lau1(b_43, 1);
  }
  addEmpty_0_nifjp9lau1(b_43, 1);
  var X60Qx_128;
  var X60Qx_129;
  if (mem.u8At((ps_58 + 16))) {
    var X60Qtmp_115 = allocFixed(72);
    mem.copy(X60Qtmp_115, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
    X60Qx_129 = (mem.u8At(X60Qtmp_115) === 14);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_115);
  } else {
    X60Qx_129 = false;
  }
  if (X60Qx_129) {
    var X60Qtmp_116 = allocFixed(72);
    mem.copy(X60Qtmp_116, tok_0_parq39nt2(ps_58, ((mem.i32(i_31) + 1) | 0)), 72);
    X60Qx_128 = (!(mem.u8At(X60Qtmp_116) === 19));
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_116);
  } else {
    X60Qx_128 = false;
  }
  if (X60Qx_128) {
    whileStmtLabel_0: {
      var rb_7 = matchClose_0_parq39nt2(ps_58, mem.i32(i_31));
      var first_2 = allocFixed(72);
      mem.copy(first_2, tok_0_parq39nt2(ps_58, ((mem.i32(i_31) + 1) | 0)), 72);
      addTree_0_nifjp9lau1(b_43, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1836348414);
        mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_58, b_43, mem.i32((first_2 + 40)), mem.i32((first_2 + 44)), mem.i32((kw_10 + 40)), mem.i32((kw_10 + 44)), false);
      var j_5 = allocFixed(4);
      mem.setI32(j_5, ((mem.i32(i_31) + 1) | 0));
      {
        while (true) {
          var X60Qx_130;
          if ((mem.i32(j_5) < rb_7)) {
            var X60Qtmp_117 = allocFixed(72);
            mem.copy(X60Qtmp_117, tok_0_parq39nt2(ps_58, mem.i32(j_5)), 72);
            X60Qx_130 = (!(mem.u8At(X60Qtmp_117) === 0));
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_117);
          } else {
            X60Qx_130 = false;
          }
          if (X60Qx_130) {
            continueLabel_1: {
              {
                var X60Qtmp_118 = allocFixed(72);
                mem.copy(X60Qtmp_118, tok_0_parq39nt2(ps_58, mem.i32(j_5)), 72);
                if ((mem.u8At(X60Qtmp_118) === 20)) {
                  inc_1_I6wjjge_cmdqs323n1(j_5);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_118);
                  break continueLabel_1;
                }
                var X60Qx_486 = parseStmt_1_parq39nt2(ps_58, b_43, mem.i32(j_5), mem.i32((first_2 + 40)), mem.i32((first_2 + 44)), rb_7);
                mem.setI32(j_5, X60Qx_486);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_118);
              }
            }
          } else {
            break;
          }
        }
      }
    }
    endTree_0_nifjp9lau1(b_43);
    mem.setI32(i_31, ((rb_7 + 1) | 0));
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_2);
  } else {
    var X60Qx_131;
    var X60Qtmp_119 = allocFixed(72);
    mem.copy(X60Qtmp_119, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
    if ((mem.u8At(X60Qtmp_119) === 9)) {
      var X60Qtmp_120 = allocFixed(72);
      mem.copy(X60Qtmp_120, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
      var X60Qx_487 = eqQ_20_sysvq0asl((X60Qtmp_120 + 4), (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 15617);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      X60Qx_131 = X60Qx_487;
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_120);
    } else {
      X60Qx_131 = false;
    }
    if (X60Qx_131) {
      inc_1_I6wjjge_cmdqs323n1(i_31);
      var refIndent_3 = mem.i32((kw_10 + 44));
      var first_3 = allocFixed(72);
      mem.copy(first_3, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
      if ((mem.u8At(first_3) === 0)) {
        addEmpty_0_nifjp9lau1(b_43, 1);
      } else {
        if ((mem.i32((first_3 + 52)) < 0)) {
          whileStmtLabel_2: {
            addTree_0_nifjp9lau1(b_43, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1836348414);
              mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_58, b_43, mem.i32((first_3 + 40)), mem.i32((first_3 + 44)), mem.i32((kw_10 + 40)), mem.i32((kw_10 + 44)), false);
            var hi_34 = lineEnd_0_parq39nt2(ps_58, mem.i32(i_31));
            {
              while (true) {
                var X60Qx_132;
                if ((mem.i32(i_31) < hi_34)) {
                  var X60Qtmp_121 = allocFixed(72);
                  mem.copy(X60Qtmp_121, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
                  X60Qx_132 = (!(mem.u8At(X60Qtmp_121) === 0));
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_121);
                } else {
                  X60Qx_132 = false;
                }
                if (X60Qx_132) {
                  var X60Qx_488 = parseStmt_1_parq39nt2(ps_58, b_43, mem.i32(i_31), mem.i32((first_3 + 40)), mem.i32((first_3 + 44)), -1);
                  mem.setI32(i_31, X60Qx_488);
                } else {
                  break;
                }
              }
            }
          }
          endTree_0_nifjp9lau1(b_43);
        } else {
          if ((refIndent_3 < mem.i32((first_3 + 52)))) {
            whileStmtLabel_3: {
              addTree_0_nifjp9lau1(b_43, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1836348414);
                mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
                return _o;
              })());
              emitInfo_0_parq39nt2(ps_58, b_43, mem.i32((first_3 + 40)), mem.i32((first_3 + 44)), mem.i32((kw_10 + 40)), mem.i32((kw_10 + 44)), false);
              {
                while (true) {
                  var X60Qx_133;
                  var X60Qtmp_122 = allocFixed(72);
                  mem.copy(X60Qtmp_122, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
                  if ((!(mem.u8At(X60Qtmp_122) === 0))) {
                    var X60Qtmp_123 = allocFixed(72);
                    mem.copy(X60Qtmp_123, tok_0_parq39nt2(ps_58, mem.i32(i_31)), 72);
                    X60Qx_133 = (refIndent_3 < mem.i32((X60Qtmp_123 + 52)));
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_123);
                  } else {
                    X60Qx_133 = false;
                  }
                  if (X60Qx_133) {
                    var X60Qx_489 = parseStmt_1_parq39nt2(ps_58, b_43, mem.i32(i_31), mem.i32((first_3 + 40)), mem.i32((first_3 + 44)), -1);
                    mem.setI32(i_31, X60Qx_489);
                  } else {
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_122);
                    break;
                  }
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_122);
                }
              }
            }
            endTree_0_nifjp9lau1(b_43);
          } else {
            addEmpty_0_nifjp9lau1(b_43, 1);
          }
        }
      }
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_3);
    } else {
      addEmpty_0_nifjp9lau1(b_43, 1);
    }
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_119);
  }
  endTree_0_nifjp9lau1(b_43);
  result_35 = mem.i32(i_31);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_113);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_112);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_111);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_109);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(name_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_10);
  return result_35;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_113);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_112);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_111);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_109);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(name_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_10);
  return result_35;
}

function parseCommand_0_parq39nt2(ps_59, b_44, lo_23, hi_23, pl_39, pc_39) {
  let callee_2 = allocFixed(72);
  mem.copy(callee_2, tok_0_parq39nt2(ps_59, lo_23), 72);
  let ce_2 = cmdCalleeEnd_0_parq39nt2(ps_59, lo_23, hi_23);
  addTree_0_nifjp9lau1(b_44, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684890371);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  emitInfo_0_parq39nt2(ps_59, b_44, mem.i32((callee_2 + 40)), mem.i32((callee_2 + 44)), pl_39, pc_39, false);
  parseExprRange_1_parq39nt2(ps_59, b_44, lo_23, ce_2, mem.i32((callee_2 + 40)), mem.i32((callee_2 + 44)));
  parseArgList_0_parq39nt2(ps_59, b_44, ce_2, hi_23, mem.i32((callee_2 + 40)), mem.i32((callee_2 + 44)));
  endTree_0_nifjp9lau1(b_44);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(callee_2);
}

function parseExprStmt_0_parq39nt2(ps_60, b_45, lo_24, hi_24, pl_40, pc_40) {
  let result_36;
  result_36 = hi_24;
  let head_2 = allocFixed(72);
  mem.copy(head_2, tok_0_parq39nt2(ps_60, lo_24), 72);
  let ce_3 = cmdCalleeEnd_0_parq39nt2(ps_60, lo_24, hi_24);
  let X60Qx_490;
  let X60Qx_491;
  if ((mem.u8At(head_2) === 1)) {
    X60Qx_491 = (ce_3 < hi_24);
  } else {
    X60Qx_491 = false;
  }
  if (X60Qx_491) {
    let X60Qx_492 = startsArg_0_parq39nt2(ps_60, ce_3, hi_24);
    X60Qx_490 = X60Qx_492;
  } else {
    X60Qx_490 = false;
  }
  let isCmd_0 = X60Qx_490;
  if (isCmd_0) {
    parseCommand_0_parq39nt2(ps_60, b_45, lo_24, hi_24, pl_40, pc_40);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(head_2);
    return result_36;
  }
  let eqi_0 = findAssign_0_parq39nt2(ps_60, lo_24, hi_24);
  if ((0 <= eqi_0)) {
    let op_4 = allocFixed(72);
    mem.copy(op_4, tok_0_parq39nt2(ps_60, eqi_0), 72);
    addTree_0_nifjp9lau1(b_45, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1735614974);
      mem.setU32((_o + 4), strlit_0_I2681092370707159476_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_60, b_45, mem.i32((op_4 + 40)), mem.i32((op_4 + 44)), pl_40, pc_40, false);
    parseExprRange_1_parq39nt2(ps_60, b_45, lo_24, eqi_0, mem.i32((op_4 + 40)), mem.i32((op_4 + 44)));
    let rt_1 = allocFixed(72);
    mem.copy(rt_1, tok_0_parq39nt2(ps_60, ((eqi_0 + 1) | 0)), 72);
    let X60Qx_493;
    if ((mem.u8At(rt_1) === 2)) {
      let X60Qx_494;
      let X60Qx_495;
      let X60Qx_496;
      let X60Qx_497;
      let X60Qx_498 = eqQ_20_sysvq0asl((rt_1 + 4), (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 6711554);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      if (X60Qx_498) {
        X60Qx_497 = true;
      } else {
        let X60Qx_499 = eqQ_20_sysvq0asl((rt_1 + 4), (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1701345278);
          mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
          return _o;
        })());
        X60Qx_497 = X60Qx_499;
      }
      if (X60Qx_497) {
        X60Qx_496 = true;
      } else {
        let X60Qx_500 = eqQ_20_sysvq0asl((rt_1 + 4), (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 2037543939);
          mem.setU32((_o + 4), 0);
          return _o;
        })());
        X60Qx_496 = X60Qx_500;
      }
      if (X60Qx_496) {
        X60Qx_495 = true;
      } else {
        let X60Qx_501 = eqQ_20_sysvq0asl((rt_1 + 4), (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1935762430);
          mem.setU32((_o + 4), strlit_0_I4956278306908871092_parq39nt2);
          return _o;
        })());
        X60Qx_495 = X60Qx_501;
      }
      if (X60Qx_495) {
        X60Qx_494 = true;
      } else {
        let X60Qx_502 = eqQ_20_sysvq0asl((rt_1 + 4), (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1869374206);
          mem.setU32((_o + 4), strlit_0_I9830314142150548690_parq39nt2);
          return _o;
        })());
        X60Qx_494 = X60Qx_502;
      }
      X60Qx_493 = X60Qx_494;
    } else {
      X60Qx_493 = false;
    }
    if (X60Qx_493) {
      let X60Qx_503 = parseCtrlFlowValue_0_parq39nt2(ps_60, b_45, ((eqi_0 + 1) | 0), mem.i32((op_4 + 40)), mem.i32((op_4 + 44)));
      result_36 = X60Qx_503;
    } else {
      parseExprRange_1_parq39nt2(ps_60, b_45, ((eqi_0 + 1) | 0), hi_24, mem.i32((op_4 + 40)), mem.i32((op_4 + 44)));
    }
    endTree_0_nifjp9lau1(b_45);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(rt_1);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(op_4);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(head_2);
    return result_36;
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(rt_1);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(op_4);
  }
  parseExprRange_1_parq39nt2(ps_60, b_45, lo_24, hi_24, pl_40, pc_40);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(head_2);
  return result_36;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(head_2);
  return result_36;
}

function parseReturnLike_0_parq39nt2(ps_61, b_46, kwIdx_5, pl_41, pc_41, tag_3) {
  let result_37;
  let kw_11 = allocFixed(72);
  mem.copy(kw_11, tok_0_parq39nt2(ps_61, kwIdx_5), 72);
  let X60Qx_504 = lineEnd_0_parq39nt2(ps_61, kwIdx_5);
  let hi_35 = semiEnd_0_parq39nt2(ps_61, kwIdx_5, X60Qx_504);
  addTree_0_nifjp9lau1(b_46, tag_3);
  emitInfo_0_parq39nt2(ps_61, b_46, mem.i32((kw_11 + 40)), mem.i32((kw_11 + 44)), pl_41, pc_41, false);
  let X60Qx_134;
  if ((((kwIdx_5 + 1) | 0) < hi_35)) {
    let X60Qtmp_124 = allocFixed(72);
    mem.copy(X60Qtmp_124, tok_0_parq39nt2(ps_61, ((kwIdx_5 + 1) | 0)), 72);
    let X60Qx_505 = startsExpr_0_parq39nt2(X60Qtmp_124);
    X60Qx_134 = X60Qx_505;
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_124);
  } else {
    X60Qx_134 = false;
  }
  if (X60Qx_134) {
    parseExprRange_1_parq39nt2(ps_61, b_46, ((kwIdx_5 + 1) | 0), hi_35, mem.i32((kw_11 + 40)), mem.i32((kw_11 + 44)));
  } else {
    addEmpty_0_nifjp9lau1(b_46, 1);
  }
  endTree_0_nifjp9lau1(b_46);
  result_37 = hi_35;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_11);
  return result_37;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_11);
  return result_37;
}

function parseImportLike_0_parq39nt2(ps_62, b_47, kwIdx_6, pl_42, pc_42, tag_4) {
  forStmtLabel_0: {
    var result_38;
    var kw_12 = allocFixed(72);
    mem.copy(kw_12, tok_0_parq39nt2(ps_62, kwIdx_6), 72);
    var X60Qx_506 = lineEnd_0_parq39nt2(ps_62, kwIdx_6);
    var hi_36 = semiEnd_0_parq39nt2(ps_62, kwIdx_6, X60Qx_506);
    addTree_0_nifjp9lau1(b_47, tag_4);
    emitInfo_0_parq39nt2(ps_62, b_47, mem.i32((kw_12 + 40)), mem.i32((kw_12 + 44)), pl_42, pc_42, false);
    var starts_6 = allocFixed(8);
    mem.copy(starts_6, splitArgs_0_parq39nt2(ps_62, ((kwIdx_6 + 1) | 0), hi_36), 8);
    {
      whileStmtLabel_1: {
        var X60Qlf_38 = 0;
        var X60Qlf_39 = len_3_I0v1j8d_parq39nt2(starts_6);
        var X60Qlf_40 = allocFixed(4);
        mem.setI32(X60Qlf_40, X60Qlf_38);
        {
          while ((mem.i32(X60Qlf_40) < X60Qlf_39)) {
            {
              var X60Qx_507 = getQ_7_Ir8kccm_parq39nt2(starts_6, mem.i32(X60Qlf_40));
              var X60Qii_2 = allocFixed(4);
              mem.setI32(X60Qii_2, mem.i32(X60Qx_507));
              var X60Qx_28;
              var X60Qx_508 = len_3_I0v1j8d_parq39nt2(starts_6);
              if ((((mem.i32(X60Qlf_40) + 1) | 0) < X60Qx_508)) {
                var X60Qx_509 = getQ_7_Ir8kccm_parq39nt2(starts_6, ((mem.i32(X60Qlf_40) + 1) | 0));
                X60Qx_28 = ((mem.i32(X60Qx_509) - 1) | 0);
              } else {
                X60Qx_28 = hi_36;
              }
              var X60Qii_3 = allocFixed(4);
              mem.setI32(X60Qii_3, X60Qx_28);
              if ((mem.i32(X60Qii_2) < mem.i32(X60Qii_3))) {
                parseExprRange_1_parq39nt2(ps_62, b_47, mem.i32(X60Qii_2), mem.i32(X60Qii_3), mem.i32((kw_12 + 40)), mem.i32((kw_12 + 44)));
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_40);
          }
        }
      }
    }
  }
  endTree_0_nifjp9lau1(b_47);
  result_38 = hi_36;
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_6);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_12);
  return result_38;
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_6);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_12);
  return result_38;
}

function isOperandEnd_0_parq39nt2(k_2) {
  let result_39;
  let X60Qx_510;
  let X60Qx_511;
  let X60Qx_512;
  let X60Qx_513;
  let X60Qx_514;
  let X60Qx_515;
  let X60Qx_516;
  let X60Qx_517;
  let X60Qx_518;
  if ((k_2 === 1)) {
    X60Qx_518 = true;
  } else {
    X60Qx_518 = (k_2 === 11);
  }
  if (X60Qx_518) {
    X60Qx_517 = true;
  } else {
    X60Qx_517 = (k_2 === 13);
  }
  if (X60Qx_517) {
    X60Qx_516 = true;
  } else {
    X60Qx_516 = (k_2 === 15);
  }
  if (X60Qx_516) {
    X60Qx_515 = true;
  } else {
    X60Qx_515 = (k_2 === 5);
  }
  if (X60Qx_515) {
    X60Qx_514 = true;
  } else {
    X60Qx_514 = (k_2 === 6);
  }
  if (X60Qx_514) {
    X60Qx_513 = true;
  } else {
    X60Qx_513 = (k_2 === 7);
  }
  if (X60Qx_513) {
    X60Qx_512 = true;
  } else {
    X60Qx_512 = (k_2 === 3);
  }
  if (X60Qx_512) {
    X60Qx_511 = true;
  } else {
    X60Qx_511 = (k_2 === 4);
  }
  if (X60Qx_511) {
    X60Qx_510 = true;
  } else {
    X60Qx_510 = (k_2 === 8);
  }
  result_39 = X60Qx_510;
  return result_39;
}

function findColon_0_parq39nt2(ps_63, lo_25, hi_25) {
  whileStmtLabel_0: {
    var result_40;
    var depth_13 = allocFixed(4);
    mem.setI32(depth_13, 0);
    var i_32 = allocFixed(4);
    mem.setI32(i_32, lo_25);
    var brace_1 = -1;
    {
      while ((mem.i32(i_32) < hi_25)) {
        var t_19 = allocFixed(72);
        mem.copy(t_19, tok_0_parq39nt2(ps_63, mem.i32(i_32)), 72);
        var X60Qx_519;
        if ((mem.i32(depth_13) === 0)) {
          X60Qx_519 = (mem.u8At(t_19) === 18);
        } else {
          X60Qx_519 = false;
        }
        if (X60Qx_519) {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_19);
          return mem.i32(i_32);
        }
        var X60Qx_135;
        var X60Qx_136;
        var X60Qx_520;
        var X60Qx_521;
        var X60Qx_522;
        if ((mem.i32(depth_13) === 0)) {
          X60Qx_522 = mem.u8At((ps_63 + 16));
        } else {
          X60Qx_522 = false;
        }
        if (X60Qx_522) {
          X60Qx_521 = (brace_1 < 0);
        } else {
          X60Qx_521 = false;
        }
        if (X60Qx_521) {
          X60Qx_520 = (mem.u8At(t_19) === 14);
        } else {
          X60Qx_520 = false;
        }
        if (X60Qx_520) {
          var X60Qtmp_125 = allocFixed(72);
          mem.copy(X60Qtmp_125, tok_0_parq39nt2(ps_63, ((mem.i32(i_32) + 1) | 0)), 72);
          X60Qx_136 = (!(mem.u8At(X60Qtmp_125) === 19));
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_125);
        } else {
          X60Qx_136 = false;
        }
        if (X60Qx_136) {
          X60Qx_135 = (lo_25 < mem.i32(i_32));
        } else {
          X60Qx_135 = false;
        }
        if (X60Qx_135) {
          var prev_3 = allocFixed(72);
          mem.copy(prev_3, tok_0_parq39nt2(ps_63, ((mem.i32(i_32) - 1) | 0)), 72);
          var X60Qx_523;
          var X60Qx_524 = isOperandEnd_0_parq39nt2(mem.u8At(prev_3));
          if (X60Qx_524) {
            X60Qx_523 = true;
          } else {
            var X60Qx_525;
            if ((mem.u8At(prev_3) === 2)) {
              var X60Qx_526;
              var X60Qx_527;
              var X60Qx_528;
              var X60Qx_529;
              var X60Qx_530 = eqQ_20_sysvq0asl((prev_3 + 4), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1936483838);
                mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
                return _o;
              })());
              if (X60Qx_530) {
                X60Qx_529 = true;
              } else {
                var X60Qx_531 = eqQ_20_sysvq0asl((prev_3 + 4), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 2037543939);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
                X60Qx_529 = X60Qx_531;
              }
              if (X60Qx_529) {
                X60Qx_528 = true;
              } else {
                var X60Qx_532 = eqQ_20_sysvq0asl((prev_3 + 4), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1869374206);
                  mem.setU32((_o + 4), strlit_0_I9830314142150548690_parq39nt2);
                  return _o;
                })());
                X60Qx_528 = X60Qx_532;
              }
              if (X60Qx_528) {
                X60Qx_527 = true;
              } else {
                var X60Qx_533 = eqQ_20_sysvq0asl((prev_3 + 4), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1852401406);
                  mem.setU32((_o + 4), strlit_0_I18082762212279024255_parq39nt2);
                  return _o;
                })());
                X60Qx_527 = X60Qx_533;
              }
              if (X60Qx_527) {
                X60Qx_526 = true;
              } else {
                var X60Qx_534 = eqQ_20_sysvq0asl((prev_3 + 4), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1717921022);
                  mem.setU32((_o + 4), strlit_0_I4167773820130397069_parq39nt2);
                  return _o;
                })());
                X60Qx_526 = X60Qx_534;
              }
              X60Qx_525 = X60Qx_526;
            } else {
              X60Qx_525 = false;
            }
            X60Qx_523 = X60Qx_525;
          }
          if (X60Qx_523) {
            brace_1 = mem.i32(i_32);
          }
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(prev_3);
        }
        var X60Qx_535 = isOpenBracket_0_parq39nt2(mem.u8At(t_19));
        if (X60Qx_535) {
          inc_1_I6wjjge_cmdqs323n1(depth_13);
        } else {
          var X60Qx_536 = isCloseBracket_0_parq39nt2(mem.u8At(t_19));
          if (X60Qx_536) {
            if ((0 < mem.i32(depth_13))) {
              dec_1_I0nzoz91_envto7w6l1(depth_13);
            }
          }
        }
        inc_1_I6wjjge_cmdqs323n1(i_32);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_19);
      }
    }
  }
  result_40 = brace_1;
  return result_40;
}

function emitBody_0_parq39nt2(ps_64, b_48, colonIdx_1, refIndent_0, pl_43, pc_43) {
  var result_41;
  if ((colonIdx_1 < 0)) {
    addTree_0_nifjp9lau1(b_48, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1836348414);
      mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
      return _o;
    })());
    addEmpty_0_nifjp9lau1(b_48, 1);
    endTree_0_nifjp9lau1(b_48);
    return colonIdx_1;
  }
  var X60Qtmp_126 = allocFixed(72);
  mem.copy(X60Qtmp_126, tok_0_parq39nt2(ps_64, colonIdx_1), 72);
  if ((mem.u8At(X60Qtmp_126) === 14)) {
    whileStmtLabel_0: {
      var rb_8 = matchClose_0_parq39nt2(ps_64, colonIdx_1);
      var first_4 = allocFixed(72);
      mem.copy(first_4, tok_0_parq39nt2(ps_64, ((colonIdx_1 + 1) | 0)), 72);
      addTree_0_nifjp9lau1(b_48, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1836348414);
        mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_64, b_48, mem.i32((first_4 + 40)), mem.i32((first_4 + 44)), pl_43, pc_43, false);
      var j_6 = allocFixed(4);
      mem.setI32(j_6, ((colonIdx_1 + 1) | 0));
      {
        while (true) {
          var X60Qx_137;
          if ((mem.i32(j_6) < rb_8)) {
            var X60Qtmp_127 = allocFixed(72);
            mem.copy(X60Qtmp_127, tok_0_parq39nt2(ps_64, mem.i32(j_6)), 72);
            X60Qx_137 = (!(mem.u8At(X60Qtmp_127) === 0));
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_127);
          } else {
            X60Qx_137 = false;
          }
          if (X60Qx_137) {
            continueLabel_1: {
              {
                var X60Qtmp_128 = allocFixed(72);
                mem.copy(X60Qtmp_128, tok_0_parq39nt2(ps_64, mem.i32(j_6)), 72);
                if ((mem.u8At(X60Qtmp_128) === 20)) {
                  inc_1_I6wjjge_cmdqs323n1(j_6);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_128);
                  break continueLabel_1;
                }
                var X60Qx_537 = parseStmt_1_parq39nt2(ps_64, b_48, mem.i32(j_6), mem.i32((first_4 + 40)), mem.i32((first_4 + 44)), rb_8);
                mem.setI32(j_6, X60Qx_537);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_128);
              }
            }
          } else {
            break;
          }
        }
      }
    }
    endTree_0_nifjp9lau1(b_48);
    result_41 = ((rb_8 + 1) | 0);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_4);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_126);
    return result_41;
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_4);
  }
  var bodyStart_1 = ((colonIdx_1 + 1) | 0);
  var first_5 = allocFixed(72);
  mem.copy(first_5, tok_0_parq39nt2(ps_64, bodyStart_1), 72);
  addTree_0_nifjp9lau1(b_48, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1836348414);
    mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
    return _o;
  })());
  emitInfo_0_parq39nt2(ps_64, b_48, mem.i32((first_5 + 40)), mem.i32((first_5 + 44)), pl_43, pc_43, false);
  var i_33 = bodyStart_1;
  if ((mem.u8At(first_5) === 0)) {
  } else {
    if ((mem.i32((first_5 + 52)) < 0)) {
      whileStmtLabel_4: {
        X60Qlab_2: {
          var hi_37 = lineEnd_0_parq39nt2(ps_64, bodyStart_1);
          {
            whileStmtLabel_3: {
              var d_4 = allocFixed(4);
              mem.setI32(d_4, 0);
              var k_14 = allocFixed(4);
              mem.setI32(k_14, bodyStart_1);
              {
                while ((mem.i32(k_14) < hi_37)) {
                  var kk_3 = allocFixed(72);
                  mem.copy(kk_3, tok_0_parq39nt2(ps_64, mem.i32(k_14)), 72);
                  var X60Qx_538 = isOpenBracket_0_parq39nt2(mem.u8At(kk_3));
                  if (X60Qx_538) {
                    inc_1_I6wjjge_cmdqs323n1(d_4);
                  } else {
                    var X60Qx_539 = isCloseBracket_0_parq39nt2(mem.u8At(kk_3));
                    if (X60Qx_539) {
                      if ((0 < mem.i32(d_4))) {
                        dec_1_I0nzoz91_envto7w6l1(d_4);
                      }
                    } else {
                      var X60Qx_540;
                      var X60Qx_541;
                      if ((mem.i32(d_4) === 0)) {
                        X60Qx_541 = (mem.u8At(kk_3) === 2);
                      } else {
                        X60Qx_541 = false;
                      }
                      if (X60Qx_541) {
                        var X60Qx_542;
                        var X60Qx_543;
                        var X60Qx_544;
                        var X60Qx_545;
                        var X60Qx_546 = eqQ_20_sysvq0asl((kk_3 + 4), (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1768711678);
                          mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
                          return _o;
                        })());
                        if (X60Qx_546) {
                          X60Qx_545 = true;
                        } else {
                          var X60Qx_547 = eqQ_20_sysvq0asl((kk_3 + 4), (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 1936483838);
                            mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
                            return _o;
                          })());
                          X60Qx_545 = X60Qx_547;
                        }
                        if (X60Qx_545) {
                          X60Qx_544 = true;
                        } else {
                          var X60Qx_548 = eqQ_20_sysvq0asl((kk_3 + 4), (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 6713090);
                            mem.setU32((_o + 4), 0);
                            return _o;
                          })());
                          X60Qx_544 = X60Qx_548;
                        }
                        if (X60Qx_544) {
                          X60Qx_543 = true;
                        } else {
                          var X60Qx_549 = eqQ_20_sysvq0asl((kk_3 + 4), (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 1668834814);
                            mem.setU32((_o + 4), strlit_0_I16264910594287870354_parq39nt2);
                            return _o;
                          })());
                          X60Qx_543 = X60Qx_549;
                        }
                        if (X60Qx_543) {
                          X60Qx_542 = true;
                        } else {
                          var X60Qx_550 = eqQ_20_sysvq0asl((kk_3 + 4), (() => {
                            var _o = allocFixed(8);
                            mem.setU32(_o, 1852401406);
                            mem.setU32((_o + 4), strlit_0_I18082762212279024255_parq39nt2);
                            return _o;
                          })());
                          X60Qx_542 = X60Qx_550;
                        }
                        X60Qx_540 = X60Qx_542;
                      } else {
                        X60Qx_540 = false;
                      }
                      if (X60Qx_540) {
                        hi_37 = mem.i32(k_14);
                        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kk_3);
                        break whileStmtLabel_3;
                      }
                    }
                  }
                  inc_1_I6wjjge_cmdqs323n1(k_14);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kk_3);
                }
              }
            }
          }
        }
        {
          while (true) {
            var X60Qx_138;
            if ((i_33 < hi_37)) {
              var X60Qtmp_129 = allocFixed(72);
              mem.copy(X60Qtmp_129, tok_0_parq39nt2(ps_64, i_33), 72);
              X60Qx_138 = (!(mem.u8At(X60Qtmp_129) === 0));
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_129);
            } else {
              X60Qx_138 = false;
            }
            if (X60Qx_138) {
              var X60Qx_551 = parseStmt_1_parq39nt2(ps_64, b_48, i_33, mem.i32((first_5 + 40)), mem.i32((first_5 + 44)), hi_37);
              i_33 = X60Qx_551;
            } else {
              break;
            }
          }
        }
      }
    } else {
      whileStmtLabel_5: {
        var bodyRef_1 = ((mem.i32((first_5 + 52)) - 1) | 0);
        {
          while (true) {
            var X60Qx_139;
            var X60Qtmp_130 = allocFixed(72);
            mem.copy(X60Qtmp_130, tok_0_parq39nt2(ps_64, i_33), 72);
            if ((!(mem.u8At(X60Qtmp_130) === 0))) {
              var X60Qtmp_131 = allocFixed(72);
              mem.copy(X60Qtmp_131, tok_0_parq39nt2(ps_64, i_33), 72);
              X60Qx_139 = (bodyRef_1 < mem.i32((X60Qtmp_131 + 52)));
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_131);
            } else {
              X60Qx_139 = false;
            }
            if (X60Qx_139) {
              var X60Qx_552 = parseStmt_1_parq39nt2(ps_64, b_48, i_33, mem.i32((first_5 + 40)), mem.i32((first_5 + 44)), -1);
              i_33 = X60Qx_552;
            } else {
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_130);
              break;
            }
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_130);
          }
        }
      }
    }
  }
  endTree_0_nifjp9lau1(b_48);
  result_41 = i_33;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_5);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_126);
  return result_41;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(first_5);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_126);
  return result_41;
}

function parseIfLike_0_parq39nt2(ps_65, b_49, kwIdx_7, pl_44, pc_44, tag_5) {
  whileStmtLabel_0: {
    var result_42;
    var kw_13 = allocFixed(72);
    mem.copy(kw_13, tok_0_parq39nt2(ps_65, kwIdx_7), 72);
    var refIndent_4 = mem.i32((kw_13 + 44));
    var lineIndent_0 = lineIndentOf_0_parq39nt2(ps_65, kwIdx_7);
    var X60Qx_553 = lineEnd_0_parq39nt2(ps_65, kwIdx_7);
    var firstColon_0 = findColon_0_parq39nt2(ps_65, kwIdx_7, X60Qx_553);
    var X60Qx_29;
    var X60Qx_140;
    if ((0 <= firstColon_0)) {
      var X60Qtmp_132 = allocFixed(72);
      mem.copy(X60Qtmp_132, tok_0_parq39nt2(ps_65, ((firstColon_0 + 1) | 0)), 72);
      X60Qx_140 = (0 <= mem.i32((X60Qtmp_132 + 52)));
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_132);
    } else {
      X60Qx_140 = false;
    }
    if (X60Qx_140) {
      var X60Qtmp_133 = allocFixed(72);
      mem.copy(X60Qtmp_133, tok_0_parq39nt2(ps_65, ((firstColon_0 + 1) | 0)), 72);
      X60Qx_29 = mem.i32((X60Qtmp_133 + 52));
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_133);
    } else {
      X60Qx_29 = 100000;
    }
    var bodyIndent_0 = X60Qx_29;
    addTree_0_nifjp9lau1(b_49, tag_5);
    emitInfo_0_parq39nt2(ps_65, b_49, mem.i32((kw_13 + 40)), mem.i32((kw_13 + 44)), pl_44, pc_44, false);
    var i_34 = kwIdx_7;
    {
      while (true) {
        continueLabel_1: {
          {
            var branch_0 = allocFixed(72);
            mem.copy(branch_0, tok_0_parq39nt2(ps_65, i_34), 72);
            var X60Qx_554;
            if ((mem.u8At(branch_0) === 2)) {
              var X60Qx_555;
              var X60Qx_556 = eqQ_20_sysvq0asl((branch_0 + 4), tag_5);
              if (X60Qx_556) {
                X60Qx_555 = true;
              } else {
                var X60Qx_557 = eqQ_20_sysvq0asl((branch_0 + 4), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1768711678);
                  mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
                  return _o;
                })());
                X60Qx_555 = X60Qx_557;
              }
              X60Qx_554 = X60Qx_555;
            } else {
              X60Qx_554 = false;
            }
            var isElif_0 = X60Qx_554;
            if (isElif_0) {
              var hi_38 = lineEnd_0_parq39nt2(ps_65, i_34);
              var colon_2 = findColon_0_parq39nt2(ps_65, i_34, hi_38);
              var condTok_0 = allocFixed(72);
              mem.copy(condTok_0, tok_0_parq39nt2(ps_65, ((i_34 + 1) | 0)), 72);
              addTree_0_nifjp9lau1(b_49, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1768711678);
                mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
                return _o;
              })());
              emitInfo_0_parq39nt2(ps_65, b_49, mem.i32((condTok_0 + 40)), mem.i32((condTok_0 + 44)), mem.i32((kw_13 + 40)), mem.i32((kw_13 + 44)), false);
              parseExprRange_1_parq39nt2(ps_65, b_49, ((i_34 + 1) | 0), colon_2, mem.i32((condTok_0 + 40)), mem.i32((condTok_0 + 44)));
              var X60Qx_558 = emitBody_0_parq39nt2(ps_65, b_49, colon_2, refIndent_4, mem.i32((condTok_0 + 40)), mem.i32((condTok_0 + 44)));
              i_34 = X60Qx_558;
              endTree_0_nifjp9lau1(b_49);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(condTok_0);
            } else {
              var X60Qx_559;
              if ((mem.u8At(branch_0) === 2)) {
                var X60Qx_560 = eqQ_20_sysvq0asl((branch_0 + 4), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1936483838);
                  mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
                  return _o;
                })());
                X60Qx_559 = X60Qx_560;
              } else {
                X60Qx_559 = false;
              }
              if (X60Qx_559) {
                var hi_39 = lineEnd_0_parq39nt2(ps_65, i_34);
                var colon_3 = findColon_0_parq39nt2(ps_65, i_34, hi_39);
                addTree_0_nifjp9lau1(b_49, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1936483838);
                  mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
                  return _o;
                })());
                emitInfo_0_parq39nt2(ps_65, b_49, mem.i32((branch_0 + 40)), mem.i32((branch_0 + 44)), mem.i32((kw_13 + 40)), mem.i32((kw_13 + 44)), false);
                var X60Qx_561 = emitBody_0_parq39nt2(ps_65, b_49, colon_3, refIndent_4, mem.i32((branch_0 + 40)), mem.i32((branch_0 + 44)));
                i_34 = X60Qx_561;
                endTree_0_nifjp9lau1(b_49);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(branch_0);
                break whileStmtLabel_0;
              } else {
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(branch_0);
                break whileStmtLabel_0;
              }
            }
            var nxt_5 = allocFixed(72);
            mem.copy(nxt_5, tok_0_parq39nt2(ps_65, i_34), 72);
            var X60Qx_562;
            var X60Qx_563;
            if ((mem.u8At(nxt_5) === 2)) {
              var X60Qx_564;
              var X60Qx_565 = eqQ_20_sysvq0asl((nxt_5 + 4), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1768711678);
                mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
                return _o;
              })());
              if (X60Qx_565) {
                X60Qx_564 = true;
              } else {
                var X60Qx_566 = eqQ_20_sysvq0asl((nxt_5 + 4), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1936483838);
                  mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
                  return _o;
                })());
                X60Qx_564 = X60Qx_566;
              }
              X60Qx_563 = X60Qx_564;
            } else {
              X60Qx_563 = false;
            }
            if (X60Qx_563) {
              var X60Qx_567;
              if ((mem.i32((nxt_5 + 52)) < 0)) {
                X60Qx_567 = true;
              } else {
                var X60Qx_568;
                if ((lineIndent_0 <= mem.i32((nxt_5 + 52)))) {
                  X60Qx_568 = (mem.i32((nxt_5 + 52)) < bodyIndent_0);
                } else {
                  X60Qx_568 = false;
                }
                X60Qx_567 = X60Qx_568;
              }
              X60Qx_562 = X60Qx_567;
            } else {
              X60Qx_562 = false;
            }
            if (X60Qx_562) {
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nxt_5);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(branch_0);
              break continueLabel_1;
            } else {
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nxt_5);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(branch_0);
              break whileStmtLabel_0;
            }
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(nxt_5);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(branch_0);
          }
        }
      }
    }
  }
  endTree_0_nifjp9lau1(b_49);
  result_42 = i_34;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_13);
  return result_42;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_13);
  return result_42;
}

function parseWhile_0_parq39nt2(ps_66, b_50, kwIdx_8, pl_45, pc_45) {
  let result_43;
  let kw_14 = allocFixed(72);
  mem.copy(kw_14, tok_0_parq39nt2(ps_66, kwIdx_8), 72);
  let refIndent_5 = mem.i32((kw_14 + 44));
  let hi_40 = lineEnd_0_parq39nt2(ps_66, kwIdx_8);
  let colon_4 = findColon_0_parq39nt2(ps_66, kwIdx_8, hi_40);
  addTree_0_nifjp9lau1(b_50, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1768454142);
    mem.setU32((_o + 4), strlit_0_I13200118161122656888_parq39nt2);
    return _o;
  })());
  emitInfo_0_parq39nt2(ps_66, b_50, mem.i32((kw_14 + 40)), mem.i32((kw_14 + 44)), pl_45, pc_45, false);
  parseExprRange_1_parq39nt2(ps_66, b_50, ((kwIdx_8 + 1) | 0), colon_4, mem.i32((kw_14 + 40)), mem.i32((kw_14 + 44)));
  let X60Qx_569 = emitBody_0_parq39nt2(ps_66, b_50, colon_4, refIndent_5, mem.i32((kw_14 + 40)), mem.i32((kw_14 + 44)));
  result_43 = X60Qx_569;
  endTree_0_nifjp9lau1(b_50);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_14);
  return result_43;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_14);
  return result_43;
}

function parseCase_0_parq39nt2(ps_67, b_51, kwIdx_9, pl_46, pc_46) {
  whileStmtLabel_0: {
    var result_44;
    var kw_15 = allocFixed(72);
    mem.copy(kw_15, tok_0_parq39nt2(ps_67, kwIdx_9), 72);
    var refIndent_6 = mem.i32((kw_15 + 44));
    var selHi_0 = lineEnd_0_parq39nt2(ps_67, kwIdx_9);
    addTree_0_nifjp9lau1(b_51, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1935762430);
      mem.setU32((_o + 4), strlit_0_I4956278306908871092_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_67, b_51, mem.i32((kw_15 + 40)), mem.i32((kw_15 + 44)), pl_46, pc_46, false);
    var selColon_0 = findColon_0_parq39nt2(ps_67, kwIdx_9, selHi_0);
    var X60Qx_30;
    if ((0 <= selColon_0)) {
      X60Qx_30 = selColon_0;
    } else {
      X60Qx_30 = selHi_0;
    }
    var selEnd_0 = X60Qx_30;
    parseExprRange_1_parq39nt2(ps_67, b_51, ((kwIdx_9 + 1) | 0), selEnd_0, mem.i32((kw_15 + 40)), mem.i32((kw_15 + 44)));
    var i_35 = selHi_0;
    var X60Qtmp_134 = allocFixed(72);
    mem.copy(X60Qtmp_134, tok_0_parq39nt2(ps_67, selHi_0), 72);
    var ofIndent_0 = mem.i32((X60Qtmp_134 + 52));
    {
      while (true) {
        var X60Qx_141;
        var X60Qx_142;
        var X60Qtmp_135 = allocFixed(72);
        mem.copy(X60Qtmp_135, tok_0_parq39nt2(ps_67, i_35), 72);
        if ((mem.u8At(X60Qtmp_135) === 2)) {
          var X60Qx_143;
          var X60Qtmp_136 = allocFixed(72);
          mem.copy(X60Qtmp_136, tok_0_parq39nt2(ps_67, i_35), 72);
          if ((mem.i32((X60Qtmp_136 + 52)) === ofIndent_0)) {
            X60Qx_143 = true;
          } else {
            var X60Qtmp_137 = allocFixed(72);
            mem.copy(X60Qtmp_137, tok_0_parq39nt2(ps_67, i_35), 72);
            X60Qx_143 = (mem.i32((X60Qtmp_137 + 52)) < 0);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_137);
          }
          X60Qx_142 = X60Qx_143;
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_136);
        } else {
          X60Qx_142 = false;
        }
        if (X60Qx_142) {
          var X60Qx_144;
          var X60Qx_145;
          var X60Qtmp_138 = allocFixed(72);
          mem.copy(X60Qtmp_138, tok_0_parq39nt2(ps_67, i_35), 72);
          var X60Qx_570 = eqQ_20_sysvq0asl((X60Qtmp_138 + 4), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 6713090);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          if (X60Qx_570) {
            X60Qx_145 = true;
          } else {
            var X60Qtmp_139 = allocFixed(72);
            mem.copy(X60Qtmp_139, tok_0_parq39nt2(ps_67, i_35), 72);
            var X60Qx_571 = eqQ_20_sysvq0asl((X60Qtmp_139 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1936483838);
              mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
              return _o;
            })());
            X60Qx_145 = X60Qx_571;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_139);
          }
          if (X60Qx_145) {
            X60Qx_144 = true;
          } else {
            var X60Qtmp_140 = allocFixed(72);
            mem.copy(X60Qtmp_140, tok_0_parq39nt2(ps_67, i_35), 72);
            var X60Qx_572 = eqQ_20_sysvq0asl((X60Qtmp_140 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1768711678);
              mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
              return _o;
            })());
            X60Qx_144 = X60Qx_572;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_140);
          }
          X60Qx_141 = X60Qx_144;
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_138);
        } else {
          X60Qx_141 = false;
        }
        if (X60Qx_141) {
          var br_2 = allocFixed(72);
          mem.copy(br_2, tok_0_parq39nt2(ps_67, i_35), 72);
          var bhi_2 = lineEnd_0_parq39nt2(ps_67, i_35);
          var bcolon_2 = findColon_0_parq39nt2(ps_67, i_35, bhi_2);
          var X60Qx_573 = eqQ_20_sysvq0asl((br_2 + 4), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 6713090);
            mem.setU32((_o + 4), 0);
            return _o;
          })());
          if (X60Qx_573) {
            forStmtLabel_1: {
              addTree_0_nifjp9lau1(b_51, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 6713090);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              emitInfo_0_parq39nt2(ps_67, b_51, mem.i32((br_2 + 40)), mem.i32((br_2 + 44)), mem.i32((kw_15 + 40)), mem.i32((kw_15 + 44)), false);
              addTree_0_nifjp9lau1(b_51, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1851880190);
                mem.setU32((_o + 4), strlit_0_I10760563625686142994_parq39nt2);
                return _o;
              })());
              var starts_7 = allocFixed(8);
              mem.copy(starts_7, splitArgs_0_parq39nt2(ps_67, ((i_35 + 1) | 0), bcolon_2), 8);
              {
                whileStmtLabel_2: {
                  var X60Qlf_41 = 0;
                  var X60Qlf_42 = len_3_I0v1j8d_parq39nt2(starts_7);
                  var X60Qlf_43 = allocFixed(4);
                  mem.setI32(X60Qlf_43, X60Qlf_41);
                  {
                    while ((mem.i32(X60Qlf_43) < X60Qlf_42)) {
                      {
                        var X60Qx_574 = getQ_7_Ir8kccm_parq39nt2(starts_7, mem.i32(X60Qlf_43));
                        var X60Qii_3 = allocFixed(4);
                        mem.setI32(X60Qii_3, mem.i32(X60Qx_574));
                        var X60Qx_31;
                        var X60Qx_575 = len_3_I0v1j8d_parq39nt2(starts_7);
                        if ((((mem.i32(X60Qlf_43) + 1) | 0) < X60Qx_575)) {
                          var X60Qx_576 = getQ_7_Ir8kccm_parq39nt2(starts_7, ((mem.i32(X60Qlf_43) + 1) | 0));
                          X60Qx_31 = ((mem.i32(X60Qx_576) - 1) | 0);
                        } else {
                          X60Qx_31 = bcolon_2;
                        }
                        var X60Qii_4 = X60Qx_31;
                        if ((mem.i32(X60Qii_3) < X60Qii_4)) {
                          parseExprRange_1_parq39nt2(ps_67, b_51, mem.i32(X60Qii_3), X60Qii_4, mem.i32((br_2 + 40)), mem.i32((br_2 + 44)));
                        }
                      }
                      inc_1_I6wjjge_cmdqs323n1(X60Qlf_43);
                    }
                  }
                }
              }
            }
            endTree_0_nifjp9lau1(b_51);
            var X60Qx_577 = emitBody_0_parq39nt2(ps_67, b_51, bcolon_2, refIndent_6, mem.i32((br_2 + 40)), mem.i32((br_2 + 44)));
            i_35 = X60Qx_577;
            endTree_0_nifjp9lau1(b_51);
            eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_7);
          } else {
            addTree_0_nifjp9lau1(b_51, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1936483838);
              mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_67, b_51, mem.i32((br_2 + 40)), mem.i32((br_2 + 44)), mem.i32((kw_15 + 40)), mem.i32((kw_15 + 44)), false);
            var X60Qx_578 = emitBody_0_parq39nt2(ps_67, b_51, bcolon_2, refIndent_6, mem.i32((br_2 + 40)), mem.i32((br_2 + 44)));
            i_35 = X60Qx_578;
            endTree_0_nifjp9lau1(b_51);
          }
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(br_2);
        } else {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_135);
          break;
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_135);
      }
    }
  }
  endTree_0_nifjp9lau1(b_51);
  result_44 = i_35;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_134);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_15);
  return result_44;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_134);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_15);
  return result_44;
}

function parseFor_0_parq39nt2(ps_68, b_52, kwIdx_10, pl_47, pc_47) {
  findIn_0: {
    var result_45;
    var kw_16 = allocFixed(72);
    mem.copy(kw_16, tok_0_parq39nt2(ps_68, kwIdx_10), 72);
    var refIndent_7 = mem.i32((kw_16 + 44));
    var hi_41 = lineEnd_0_parq39nt2(ps_68, kwIdx_10);
    var colon_5 = findColon_0_parq39nt2(ps_68, kwIdx_10, hi_41);
    var inIdx_0 = -1;
    {
      whileStmtLabel_0: {
        var depth_14 = allocFixed(4);
        mem.setI32(depth_14, 0);
        var j_7 = allocFixed(4);
        mem.setI32(j_7, ((kwIdx_10 + 1) | 0));
        {
          while ((mem.i32(j_7) < colon_5)) {
            var t_20 = allocFixed(72);
            mem.copy(t_20, tok_0_parq39nt2(ps_68, mem.i32(j_7)), 72);
            var X60Qx_579 = isOpenBracket_0_parq39nt2(mem.u8At(t_20));
            if (X60Qx_579) {
              inc_1_I6wjjge_cmdqs323n1(depth_14);
            } else {
              var X60Qx_580 = isCloseBracket_0_parq39nt2(mem.u8At(t_20));
              if (X60Qx_580) {
                if ((0 < mem.i32(depth_14))) {
                  dec_1_I0nzoz91_envto7w6l1(depth_14);
                }
              } else {
                var X60Qx_581;
                var X60Qx_582;
                if ((mem.i32(depth_14) === 0)) {
                  X60Qx_582 = (mem.u8At(t_20) === 2);
                } else {
                  X60Qx_582 = false;
                }
                if (X60Qx_582) {
                  var X60Qx_583 = eqQ_20_sysvq0asl((t_20 + 4), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 7235842);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })());
                  X60Qx_581 = X60Qx_583;
                } else {
                  X60Qx_581 = false;
                }
                if (X60Qx_581) {
                  inIdx_0 = mem.i32(j_7);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_20);
                  break findIn_0;
                }
              }
            }
            inc_1_I6wjjge_cmdqs323n1(j_7);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_20);
          }
        }
      }
    }
  }
  var firstVar_0 = allocFixed(72);
  mem.copy(firstVar_0, tok_0_parq39nt2(ps_68, ((kwIdx_10 + 1) | 0)), 72);
  addTree_0_nifjp9lau1(b_52, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1919903235);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  emitInfo_0_parq39nt2(ps_68, b_52, mem.i32((firstVar_0 + 40)), mem.i32((firstVar_0 + 44)), pl_47, pc_47, false);
  parseExprRange_1_parq39nt2(ps_68, b_52, ((inIdx_0 + 1) | 0), colon_5, mem.i32((firstVar_0 + 40)), mem.i32((firstVar_0 + 44)));
  if ((mem.u8At(firstVar_0) === 10)) {
    forStmtLabel_1: {
      var rp_4 = matchClose_0_parq39nt2(ps_68, ((kwIdx_10 + 1) | 0));
      addTree_0_nifjp9lau1(b_52, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1886287358);
        mem.setU32((_o + 4), strlit_0_I1237672436915077942_parq39nt2);
        return _o;
      })());
      var starts_8 = allocFixed(8);
      mem.copy(starts_8, splitArgs_0_parq39nt2(ps_68, ((kwIdx_10 + 2) | 0), rp_4), 8);
      {
        whileStmtLabel_2: {
          var X60Qlf_44 = 0;
          var X60Qlf_45 = len_3_I0v1j8d_parq39nt2(starts_8);
          var X60Qlf_46 = allocFixed(4);
          mem.setI32(X60Qlf_46, X60Qlf_44);
          {
            while ((mem.i32(X60Qlf_46) < X60Qlf_45)) {
              {
                var X60Qx_584 = getQ_7_Ir8kccm_parq39nt2(starts_8, mem.i32(X60Qlf_46));
                var X60Qii_3 = allocFixed(72);
                mem.copy(X60Qii_3, tok_0_parq39nt2(ps_68, mem.i32(X60Qx_584)), 72);
                addTree_0_nifjp9lau1(b_52, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1952803843);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
                addIdent_0_nifjp9lau1(b_52, (X60Qii_3 + 4));
                emitInfo_0_parq39nt2(ps_68, b_52, mem.i32((X60Qii_3 + 40)), mem.i32((X60Qii_3 + 44)), mem.i32((firstVar_0 + 40)), mem.i32((firstVar_0 + 44)), false);
                addEmpty_0_nifjp9lau1(b_52, 4);
                endTree_0_nifjp9lau1(b_52);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_3);
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_46);
            }
          }
        }
      }
    }
    endTree_0_nifjp9lau1(b_52);
    eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_8);
  } else {
    forStmtLabel_4: {
      addTree_0_nifjp9lau1(b_52, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1886287358);
        mem.setU32((_o + 4), strlit_0_I13179338205702368459_parq39nt2);
        return _o;
      })());
      var starts_9 = allocFixed(8);
      mem.copy(starts_9, splitArgs_0_parq39nt2(ps_68, ((kwIdx_10 + 1) | 0), inIdx_0), 8);
      {
        whileStmtLabel_5: {
          var X60Qlf_47 = 0;
          var X60Qlf_48 = len_3_I0v1j8d_parq39nt2(starts_9);
          var X60Qlf_49 = allocFixed(4);
          mem.setI32(X60Qlf_49, X60Qlf_47);
          {
            while ((mem.i32(X60Qlf_49) < X60Qlf_48)) {
              {
                var X60Qx_585 = getQ_7_Ir8kccm_parq39nt2(starts_9, mem.i32(X60Qlf_49));
                var X60Qii_6 = allocFixed(72);
                mem.copy(X60Qii_6, tok_0_parq39nt2(ps_68, mem.i32(X60Qx_585)), 72);
                addTree_0_nifjp9lau1(b_52, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1952803843);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
                addIdent_0_nifjp9lau1(b_52, (X60Qii_6 + 4));
                emitInfo_0_parq39nt2(ps_68, b_52, mem.i32((X60Qii_6 + 40)), mem.i32((X60Qii_6 + 44)), mem.i32((firstVar_0 + 40)), mem.i32((firstVar_0 + 44)), false);
                addEmpty_0_nifjp9lau1(b_52, 1);
                addEmpty_0_nifjp9lau1(b_52, 1);
                addEmpty_0_nifjp9lau1(b_52, 2);
                endTree_0_nifjp9lau1(b_52);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_6);
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_49);
            }
          }
        }
      }
    }
    endTree_0_nifjp9lau1(b_52);
    eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_9);
  }
  var X60Qx_586 = emitBody_0_parq39nt2(ps_68, b_52, colon_5, refIndent_7, mem.i32((firstVar_0 + 40)), mem.i32((firstVar_0 + 44)));
  result_45 = X60Qx_586;
  endTree_0_nifjp9lau1(b_52);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(firstVar_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_16);
  return result_45;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(firstVar_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_16);
  return result_45;
}

function parseTryExpr_1_parq39nt2(ps_69, b_53, lo_26, hi_26, pl_48, pc_48) {
  forStmtLabel_2: {
    X60Qlab_0: {
      var kw_17 = allocFixed(72);
      mem.copy(kw_17, tok_0_parq39nt2(ps_69, lo_26), 72);
      addTree_0_nifjp9lau1(b_53, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 2037543939);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      emitInfo_0_parq39nt2(ps_69, b_53, mem.i32((kw_17 + 40)), mem.i32((kw_17 + 44)), pl_48, pc_48, false);
      var branches_0 = allocFixed(8);
      mem.copy(branches_0, newSeqUninit_0_Iggfvwp_mat7cnfv21(0), 8);
      {
        whileStmtLabel_1: {
          var d_5 = allocFixed(4);
          mem.setI32(d_5, 0);
          var i_36 = allocFixed(4);
          mem.setI32(i_36, ((lo_26 + 1) | 0));
          {
            while ((mem.i32(i_36) < hi_26)) {
              var t_21 = allocFixed(72);
              mem.copy(t_21, tok_0_parq39nt2(ps_69, mem.i32(i_36)), 72);
              var X60Qx_587 = isOpenBracket_0_parq39nt2(mem.u8At(t_21));
              if (X60Qx_587) {
                inc_1_I6wjjge_cmdqs323n1(d_5);
              } else {
                var X60Qx_588 = isCloseBracket_0_parq39nt2(mem.u8At(t_21));
                if (X60Qx_588) {
                  if ((0 < mem.i32(d_5))) {
                    dec_1_I0nzoz91_envto7w6l1(d_5);
                  }
                } else {
                  var X60Qx_589;
                  var X60Qx_590;
                  if ((mem.i32(d_5) === 0)) {
                    X60Qx_590 = (mem.u8At(t_21) === 2);
                  } else {
                    X60Qx_590 = false;
                  }
                  if (X60Qx_590) {
                    var X60Qx_591;
                    var X60Qx_592 = eqQ_20_sysvq0asl((t_21 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1668834814);
                      mem.setU32((_o + 4), strlit_0_I16264910594287870354_parq39nt2);
                      return _o;
                    })());
                    if (X60Qx_592) {
                      X60Qx_591 = true;
                    } else {
                      var X60Qx_593 = eqQ_20_sysvq0asl((t_21 + 4), (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 1852401406);
                        mem.setU32((_o + 4), strlit_0_I18082762212279024255_parq39nt2);
                        return _o;
                      })());
                      X60Qx_591 = X60Qx_593;
                    }
                    X60Qx_589 = X60Qx_591;
                  } else {
                    X60Qx_589 = false;
                  }
                  if (X60Qx_589) {
                    add_0_I8kd4i4_parq39nt2(branches_0, mem.i32(i_36));
                  }
                }
              }
              inc_1_I6wjjge_cmdqs323n1(i_36);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_21);
            }
          }
        }
      }
    }
    var X60Qx_32;
    if ((0 < mem.i32(branches_0))) {
      var X60Qx_594 = getQ_7_Ir8kccm_parq39nt2(branches_0, 0);
      X60Qx_32 = mem.i32(X60Qx_594);
    } else {
      X60Qx_32 = hi_26;
    }
    var firstBranch_0 = X60Qx_32;
    var colon_6 = findColon_0_parq39nt2(ps_69, lo_26, firstBranch_0);
    var X60Qx_595;
    if ((0 <= colon_6)) {
      X60Qx_595 = (((colon_6 + 1) | 0) < firstBranch_0);
    } else {
      X60Qx_595 = false;
    }
    if (X60Qx_595) {
      parseExprRange_1_parq39nt2(ps_69, b_53, ((colon_6 + 1) | 0), firstBranch_0, mem.i32((kw_17 + 40)), mem.i32((kw_17 + 44)));
    } else {
      addEmpty_0_nifjp9lau1(b_53, 1);
    }
    {
      whileStmtLabel_3: {
        var X60Qlf_50 = 0;
        var X60Qlf_51 = len_3_I0v1j8d_parq39nt2(branches_0);
        var X60Qlf_52 = allocFixed(4);
        mem.setI32(X60Qlf_52, X60Qlf_50);
        {
          while ((mem.i32(X60Qlf_52) < X60Qlf_51)) {
            {
              var X60Qx_596 = getQ_7_Ir8kccm_parq39nt2(branches_0, mem.i32(X60Qlf_52));
              var X60Qii_4 = mem.i32(X60Qx_596);
              var X60Qii_5 = allocFixed(72);
              mem.copy(X60Qii_5, tok_0_parq39nt2(ps_69, X60Qii_4), 72);
              var X60Qx_33;
              var X60Qx_597 = len_3_I0v1j8d_parq39nt2(branches_0);
              if ((((mem.i32(X60Qlf_52) + 1) | 0) < X60Qx_597)) {
                var X60Qx_598 = getQ_7_Ir8kccm_parq39nt2(branches_0, ((mem.i32(X60Qlf_52) + 1) | 0));
                X60Qx_33 = mem.i32(X60Qx_598);
              } else {
                X60Qx_33 = hi_26;
              }
              var X60Qii_6 = allocFixed(4);
              mem.setI32(X60Qii_6, X60Qx_33);
              var X60Qii_7 = allocFixed(4);
              mem.setI32(X60Qii_7, findColon_0_parq39nt2(ps_69, X60Qii_4, mem.i32(X60Qii_6)));
              var X60Qx_599 = eqQ_20_sysvq0asl((X60Qii_5 + 4), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1668834814);
                mem.setU32((_o + 4), strlit_0_I16264910594287870354_parq39nt2);
                return _o;
              })());
              if (X60Qx_599) {
                addTree_0_nifjp9lau1(b_53, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1668834814);
                  mem.setU32((_o + 4), strlit_0_I16264910594287870354_parq39nt2);
                  return _o;
                })());
                emitInfo_0_parq39nt2(ps_69, b_53, mem.i32((X60Qii_5 + 40)), mem.i32((X60Qii_5 + 44)), mem.i32((kw_17 + 40)), mem.i32((kw_17 + 44)), false);
                if ((((X60Qii_4 + 1) | 0) < mem.i32(X60Qii_7))) {
                  parseExprRange_1_parq39nt2(ps_69, b_53, ((X60Qii_4 + 1) | 0), mem.i32(X60Qii_7), mem.i32((X60Qii_5 + 40)), mem.i32((X60Qii_5 + 44)));
                } else {
                  addEmpty_0_nifjp9lau1(b_53, 1);
                }
                var X60Qx_600;
                if ((0 <= mem.i32(X60Qii_7))) {
                  X60Qx_600 = (((mem.i32(X60Qii_7) + 1) | 0) < mem.i32(X60Qii_6));
                } else {
                  X60Qx_600 = false;
                }
                if (X60Qx_600) {
                  parseExprRange_1_parq39nt2(ps_69, b_53, ((mem.i32(X60Qii_7) + 1) | 0), mem.i32(X60Qii_6), mem.i32((X60Qii_5 + 40)), mem.i32((X60Qii_5 + 44)));
                } else {
                  addEmpty_0_nifjp9lau1(b_53, 1);
                }
                endTree_0_nifjp9lau1(b_53);
              } else {
                addTree_0_nifjp9lau1(b_53, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1852401155);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
                emitInfo_0_parq39nt2(ps_69, b_53, mem.i32((X60Qii_5 + 40)), mem.i32((X60Qii_5 + 44)), mem.i32((kw_17 + 40)), mem.i32((kw_17 + 44)), false);
                var X60Qx_601;
                if ((0 <= mem.i32(X60Qii_7))) {
                  X60Qx_601 = (((mem.i32(X60Qii_7) + 1) | 0) < mem.i32(X60Qii_6));
                } else {
                  X60Qx_601 = false;
                }
                if (X60Qx_601) {
                  parseExprRange_1_parq39nt2(ps_69, b_53, ((mem.i32(X60Qii_7) + 1) | 0), mem.i32(X60Qii_6), mem.i32((X60Qii_5 + 40)), mem.i32((X60Qii_5 + 44)));
                } else {
                  addEmpty_0_nifjp9lau1(b_53, 1);
                }
                endTree_0_nifjp9lau1(b_53);
              }
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_5);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_52);
          }
        }
      }
    }
  }
  endTree_0_nifjp9lau1(b_53);
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(branches_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_17);
}

function parseTry_1_parq39nt2(ps_70, b_54, kwIdx_11, pl_49, pc_49) {
  whileStmtLabel_0: {
    var result_46;
    var kw_18 = allocFixed(72);
    mem.copy(kw_18, tok_0_parq39nt2(ps_70, kwIdx_11), 72);
    var refIndent_8 = mem.i32((kw_18 + 44));
    var lineIndent_1 = lineIndentOf_0_parq39nt2(ps_70, kwIdx_11);
    addTree_0_nifjp9lau1(b_54, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 2037543939);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_70, b_54, mem.i32((kw_18 + 40)), mem.i32((kw_18 + 44)), pl_49, pc_49, false);
    var hi_42 = lineEnd_0_parq39nt2(ps_70, kwIdx_11);
    var colon_7 = findColon_0_parq39nt2(ps_70, kwIdx_11, hi_42);
    var X60Qx_34;
    var X60Qx_146;
    if ((0 <= colon_7)) {
      var X60Qtmp_141 = allocFixed(72);
      mem.copy(X60Qtmp_141, tok_0_parq39nt2(ps_70, ((colon_7 + 1) | 0)), 72);
      X60Qx_146 = (0 <= mem.i32((X60Qtmp_141 + 52)));
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_141);
    } else {
      X60Qx_146 = false;
    }
    if (X60Qx_146) {
      var X60Qtmp_142 = allocFixed(72);
      mem.copy(X60Qtmp_142, tok_0_parq39nt2(ps_70, ((colon_7 + 1) | 0)), 72);
      X60Qx_34 = mem.i32((X60Qtmp_142 + 52));
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_142);
    } else {
      X60Qx_34 = 100000;
    }
    var bodyIndent_1 = X60Qx_34;
    var i_37 = emitBody_0_parq39nt2(ps_70, b_54, colon_7, refIndent_8, mem.i32((kw_18 + 40)), mem.i32((kw_18 + 44)));
    {
      while (true) {
        var X60Qx_147;
        var X60Qx_148;
        var X60Qtmp_143 = allocFixed(72);
        mem.copy(X60Qtmp_143, tok_0_parq39nt2(ps_70, i_37), 72);
        if ((mem.u8At(X60Qtmp_143) === 2)) {
          var X60Qx_149;
          var X60Qtmp_144 = allocFixed(72);
          mem.copy(X60Qtmp_144, tok_0_parq39nt2(ps_70, i_37), 72);
          if ((mem.i32((X60Qtmp_144 + 52)) < 0)) {
            X60Qx_149 = true;
          } else {
            var X60Qx_150;
            var X60Qtmp_145 = allocFixed(72);
            mem.copy(X60Qtmp_145, tok_0_parq39nt2(ps_70, i_37), 72);
            if ((lineIndent_1 <= mem.i32((X60Qtmp_145 + 52)))) {
              var X60Qtmp_146 = allocFixed(72);
              mem.copy(X60Qtmp_146, tok_0_parq39nt2(ps_70, i_37), 72);
              X60Qx_150 = (mem.i32((X60Qtmp_146 + 52)) < bodyIndent_1);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_146);
            } else {
              X60Qx_150 = false;
            }
            X60Qx_149 = X60Qx_150;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_145);
          }
          X60Qx_148 = X60Qx_149;
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_144);
        } else {
          X60Qx_148 = false;
        }
        if (X60Qx_148) {
          var X60Qx_151;
          var X60Qtmp_147 = allocFixed(72);
          mem.copy(X60Qtmp_147, tok_0_parq39nt2(ps_70, i_37), 72);
          var X60Qx_602 = eqQ_20_sysvq0asl((X60Qtmp_147 + 4), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1668834814);
            mem.setU32((_o + 4), strlit_0_I16264910594287870354_parq39nt2);
            return _o;
          })());
          if (X60Qx_602) {
            X60Qx_151 = true;
          } else {
            var X60Qtmp_148 = allocFixed(72);
            mem.copy(X60Qtmp_148, tok_0_parq39nt2(ps_70, i_37), 72);
            var X60Qx_603 = eqQ_20_sysvq0asl((X60Qtmp_148 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1852401406);
              mem.setU32((_o + 4), strlit_0_I18082762212279024255_parq39nt2);
              return _o;
            })());
            X60Qx_151 = X60Qx_603;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_148);
          }
          X60Qx_147 = X60Qx_151;
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_147);
        } else {
          X60Qx_147 = false;
        }
        if (X60Qx_147) {
          var br_4 = allocFixed(72);
          mem.copy(br_4, tok_0_parq39nt2(ps_70, i_37), 72);
          var bhi_3 = lineEnd_0_parq39nt2(ps_70, i_37);
          var bcolon_4 = findColon_0_parq39nt2(ps_70, i_37, bhi_3);
          var X60Qx_604 = eqQ_20_sysvq0asl((br_4 + 4), (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1668834814);
            mem.setU32((_o + 4), strlit_0_I16264910594287870354_parq39nt2);
            return _o;
          })());
          if (X60Qx_604) {
            addTree_0_nifjp9lau1(b_54, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1668834814);
              mem.setU32((_o + 4), strlit_0_I16264910594287870354_parq39nt2);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_70, b_54, mem.i32((br_4 + 40)), mem.i32((br_4 + 44)), mem.i32((kw_18 + 40)), mem.i32((kw_18 + 44)), false);
            if ((((i_37 + 1) | 0) < bcolon_4)) {
              parseExprRange_1_parq39nt2(ps_70, b_54, ((i_37 + 1) | 0), bcolon_4, mem.i32((br_4 + 40)), mem.i32((br_4 + 44)));
            } else {
              addEmpty_0_nifjp9lau1(b_54, 1);
            }
            var X60Qx_605 = emitBody_0_parq39nt2(ps_70, b_54, bcolon_4, refIndent_8, mem.i32((br_4 + 40)), mem.i32((br_4 + 44)));
            i_37 = X60Qx_605;
            endTree_0_nifjp9lau1(b_54);
          } else {
            addTree_0_nifjp9lau1(b_54, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1852401155);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            emitInfo_0_parq39nt2(ps_70, b_54, mem.i32((br_4 + 40)), mem.i32((br_4 + 44)), mem.i32((kw_18 + 40)), mem.i32((kw_18 + 44)), false);
            var X60Qx_606 = emitBody_0_parq39nt2(ps_70, b_54, bcolon_4, refIndent_8, mem.i32((br_4 + 40)), mem.i32((br_4 + 44)));
            i_37 = X60Qx_606;
            endTree_0_nifjp9lau1(b_54);
          }
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(br_4);
        } else {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_143);
          break;
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_143);
      }
    }
  }
  endTree_0_nifjp9lau1(b_54);
  result_46 = i_37;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_18);
  return result_46;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_18);
  return result_46;
}

function parseBlock_0_parq39nt2(ps_71, b_55, kwIdx_12, pl_50, pc_50) {
  let result_47;
  let kw_19 = allocFixed(72);
  mem.copy(kw_19, tok_0_parq39nt2(ps_71, kwIdx_12), 72);
  let refIndent_9 = mem.i32((kw_19 + 44));
  addTree_0_nifjp9lau1(b_55, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869374206);
    mem.setU32((_o + 4), strlit_0_I9830314142150548690_parq39nt2);
    return _o;
  })());
  emitInfo_0_parq39nt2(ps_71, b_55, mem.i32((kw_19 + 40)), mem.i32((kw_19 + 44)), pl_50, pc_50, false);
  let hi_43 = lineEnd_0_parq39nt2(ps_71, kwIdx_12);
  let colon_8 = findColon_0_parq39nt2(ps_71, kwIdx_12, hi_43);
  let X60Qx_152;
  if ((((kwIdx_12 + 1) | 0) < colon_8)) {
    let X60Qtmp_149 = allocFixed(72);
    mem.copy(X60Qtmp_149, tok_0_parq39nt2(ps_71, ((kwIdx_12 + 1) | 0)), 72);
    X60Qx_152 = (mem.u8At(X60Qtmp_149) === 1);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_149);
  } else {
    X60Qx_152 = false;
  }
  if (X60Qx_152) {
    let lbl_0 = allocFixed(72);
    mem.copy(lbl_0, tok_0_parq39nt2(ps_71, ((kwIdx_12 + 1) | 0)), 72);
    addIdent_0_nifjp9lau1(b_55, (lbl_0 + 4));
    emitInfo_0_parq39nt2(ps_71, b_55, mem.i32((lbl_0 + 40)), mem.i32((lbl_0 + 44)), mem.i32((kw_19 + 40)), mem.i32((kw_19 + 44)), false);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(lbl_0);
  } else {
    addEmpty_0_nifjp9lau1(b_55, 1);
  }
  let X60Qx_607 = emitBody_0_parq39nt2(ps_71, b_55, colon_8, refIndent_9, mem.i32((kw_19 + 40)), mem.i32((kw_19 + 44)));
  result_47 = X60Qx_607;
  endTree_0_nifjp9lau1(b_55);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_19);
  return result_47;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_19);
  return result_47;
}

function parseBreakLike_0_parq39nt2(ps_72, b_56, kwIdx_13, pl_51, pc_51, tag_6) {
  let result_48;
  let kw_20 = allocFixed(72);
  mem.copy(kw_20, tok_0_parq39nt2(ps_72, kwIdx_13), 72);
  let hi_44 = lineEnd_0_parq39nt2(ps_72, kwIdx_13);
  addTree_0_nifjp9lau1(b_56, tag_6);
  emitInfo_0_parq39nt2(ps_72, b_56, mem.i32((kw_20 + 40)), mem.i32((kw_20 + 44)), pl_51, pc_51, false);
  let X60Qx_153;
  if ((((kwIdx_13 + 1) | 0) < hi_44)) {
    let X60Qtmp_150 = allocFixed(72);
    mem.copy(X60Qtmp_150, tok_0_parq39nt2(ps_72, ((kwIdx_13 + 1) | 0)), 72);
    X60Qx_153 = (mem.u8At(X60Qtmp_150) === 1);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_150);
  } else {
    X60Qx_153 = false;
  }
  if (X60Qx_153) {
    let lbl_1 = allocFixed(72);
    mem.copy(lbl_1, tok_0_parq39nt2(ps_72, ((kwIdx_13 + 1) | 0)), 72);
    addIdent_0_nifjp9lau1(b_56, (lbl_1 + 4));
    emitInfo_0_parq39nt2(ps_72, b_56, mem.i32((lbl_1 + 40)), mem.i32((lbl_1 + 44)), mem.i32((kw_20 + 40)), mem.i32((kw_20 + 44)), false);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(lbl_1);
  } else {
    addEmpty_0_nifjp9lau1(b_56, 1);
  }
  endTree_0_nifjp9lau1(b_56);
  result_48 = hi_44;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_20);
  return result_48;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_20);
  return result_48;
}

function parseDefer_0_parq39nt2(ps_73, b_57, kwIdx_14, pl_52, pc_52) {
  let result_49;
  let kw_21 = allocFixed(72);
  mem.copy(kw_21, tok_0_parq39nt2(ps_73, kwIdx_14), 72);
  let refIndent_10 = mem.i32((kw_21 + 44));
  addTree_0_nifjp9lau1(b_57, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1717921022);
    mem.setU32((_o + 4), strlit_0_I4167773820130397069_parq39nt2);
    return _o;
  })());
  emitInfo_0_parq39nt2(ps_73, b_57, mem.i32((kw_21 + 40)), mem.i32((kw_21 + 44)), pl_52, pc_52, false);
  let hi_45 = lineEnd_0_parq39nt2(ps_73, kwIdx_14);
  let colon_9 = findColon_0_parq39nt2(ps_73, kwIdx_14, hi_45);
  let X60Qx_608 = emitBody_0_parq39nt2(ps_73, b_57, colon_9, refIndent_10, mem.i32((kw_21 + 40)), mem.i32((kw_21 + 44)));
  result_49 = X60Qx_608;
  endTree_0_nifjp9lau1(b_57);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_21);
  return result_49;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_21);
  return result_49;
}

function parseCtrlFlowValue_0_parq39nt2(ps_74, b_58, kwIdx_15, pl_53, pc_53) {
  let result_50;
  let X60Qtmp_151 = allocFixed(72);
  mem.copy(X60Qtmp_151, tok_0_parq39nt2(ps_74, kwIdx_15), 72);
  let s_13 = allocFixed(8);
  mem.copy(s_13, nimStrDup((X60Qtmp_151 + 4)), 8);
  let X60Qx_609 = eqQ_20_sysvq0asl(s_13, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2037543939);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  if (X60Qx_609) {
    let X60Qx_610 = parseTry_1_parq39nt2(ps_74, b_58, kwIdx_15, pl_53, pc_53);
    result_50 = X60Qx_610;
  } else {
    let X60Qx_611 = eqQ_20_sysvq0asl(s_13, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 6711554);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    if (X60Qx_611) {
      let X60Qx_612 = parseIfLike_0_parq39nt2(ps_74, b_58, kwIdx_15, pl_53, pc_53, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 6711554);
        mem.setU32((_o + 4), 0);
        return _o;
      })());
      result_50 = X60Qx_612;
    } else {
      let X60Qx_613 = eqQ_20_sysvq0asl(s_13, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 1701345278);
        mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
        return _o;
      })());
      if (X60Qx_613) {
        let X60Qx_614 = parseIfLike_0_parq39nt2(ps_74, b_58, kwIdx_15, pl_53, pc_53, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1701345278);
          mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
          return _o;
        })());
        result_50 = X60Qx_614;
      } else {
        let X60Qx_615 = eqQ_20_sysvq0asl(s_13, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1935762430);
          mem.setU32((_o + 4), strlit_0_I4956278306908871092_parq39nt2);
          return _o;
        })());
        if (X60Qx_615) {
          let X60Qx_616 = parseCase_0_parq39nt2(ps_74, b_58, kwIdx_15, pl_53, pc_53);
          result_50 = X60Qx_616;
        } else {
          let X60Qx_617 = eqQ_20_sysvq0asl(s_13, (() => {
            let _o = allocFixed(8);
            mem.setU32(_o, 1869374206);
            mem.setU32((_o + 4), strlit_0_I9830314142150548690_parq39nt2);
            return _o;
          })());
          if (X60Qx_617) {
            let X60Qx_618 = parseBlock_0_parq39nt2(ps_74, b_58, kwIdx_15, pl_53, pc_53);
            result_50 = X60Qx_618;
          } else {
            result_50 = kwIdx_15;
          }
        }
      }
    }
  }
  nimStrDestroy(s_13);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_151);
  return result_50;
  nimStrDestroy(s_13);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_151);
  return result_50;
}

function parseSectionDef_0_parq39nt2(ps_75, b_59, lo_27, hi_27, tag_7, pl_54, pc_54) {
  forStmtLabel_5: {
    X60Qlab_3: {
      var result_51;
      result_51 = hi_27;
      var X60Qtmp_152 = allocFixed(72);
      mem.copy(X60Qtmp_152, tok_0_parq39nt2(ps_75, lo_27), 72);
      if ((mem.u8At(X60Qtmp_152) === 10)) {
        forStmtLabel_0: {
          var lp_3 = allocFixed(72);
          mem.copy(lp_3, tok_0_parq39nt2(ps_75, lo_27), 72);
          var rp_5 = matchClose_0_parq39nt2(ps_75, lo_27);
          var assign_0 = findAssign_0_parq39nt2(ps_75, ((rp_5 + 1) | 0), hi_27);
          addTree_0_nifjp9lau1(b_59, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1886287358);
            mem.setU32((_o + 4), strlit_0_I7731358638274129439_parq39nt2);
            return _o;
          })());
          emitInfo_0_parq39nt2(ps_75, b_59, mem.i32((lp_3 + 40)), mem.i32((lp_3 + 44)), pl_54, pc_54, false);
          var X60Qx_619;
          if ((0 <= assign_0)) {
            X60Qx_619 = (((assign_0 + 1) | 0) < hi_27);
          } else {
            X60Qx_619 = false;
          }
          if (X60Qx_619) {
            parseExprRange_1_parq39nt2(ps_75, b_59, ((assign_0 + 1) | 0), hi_27, mem.i32((lp_3 + 40)), mem.i32((lp_3 + 44)));
          } else {
            addEmpty_0_nifjp9lau1(b_59, 1);
          }
          addTree_0_nifjp9lau1(b_59, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1886287358);
            mem.setU32((_o + 4), strlit_0_I1237672436915077942_parq39nt2);
            return _o;
          })());
          var starts_10 = allocFixed(8);
          mem.copy(starts_10, splitArgs_0_parq39nt2(ps_75, ((lo_27 + 1) | 0), rp_5), 8);
          {
            whileStmtLabel_1: {
              var X60Qlf_53 = 0;
              var X60Qlf_54 = len_3_I0v1j8d_parq39nt2(starts_10);
              var X60Qlf_55 = allocFixed(4);
              mem.setI32(X60Qlf_55, X60Qlf_53);
              {
                while ((mem.i32(X60Qlf_55) < X60Qlf_54)) {
                  {
                    var X60Qx_620 = getQ_7_Ir8kccm_parq39nt2(starts_10, mem.i32(X60Qlf_55));
                    var X60Qii_2 = allocFixed(72);
                    mem.copy(X60Qii_2, tok_0_parq39nt2(ps_75, mem.i32(X60Qx_620)), 72);
                    addTree_0_nifjp9lau1(b_59, tag_7);
                    addIdent_0_nifjp9lau1(b_59, (X60Qii_2 + 4));
                    emitInfo_0_parq39nt2(ps_75, b_59, mem.i32((X60Qii_2 + 40)), mem.i32((X60Qii_2 + 44)), mem.i32((lp_3 + 40)), mem.i32((lp_3 + 44)), false);
                    addEmpty_0_nifjp9lau1(b_59, 1);
                    addEmpty_0_nifjp9lau1(b_59, 1);
                    addEmpty_0_nifjp9lau1(b_59, 2);
                    endTree_0_nifjp9lau1(b_59);
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_2);
                  }
                  inc_1_I6wjjge_cmdqs323n1(X60Qlf_55);
                }
              }
            }
          }
        }
        endTree_0_nifjp9lau1(b_59);
        endTree_0_nifjp9lau1(b_59);
        eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_10);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(lp_3);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_152);
        return result_51;
        eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_10);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(lp_3);
      }
      var colon_10 = findColon_0_parq39nt2(ps_75, lo_27, hi_27);
      var assign_1 = findAssign_0_parq39nt2(ps_75, lo_27, hi_27);
      var X60Qx_35;
      if ((0 <= colon_10)) {
        X60Qx_35 = colon_10;
      } else {
        if ((0 <= assign_1)) {
          X60Qx_35 = assign_1;
        } else {
          X60Qx_35 = hi_27;
        }
      }
      var boundary_0 = X60Qx_35;
      var pragLo_4 = -1;
      var pragHi_4 = -1;
      {
        whileStmtLabel_4: {
          var d_6 = allocFixed(4);
          mem.setI32(d_6, 0);
          var k_15 = allocFixed(4);
          mem.setI32(k_15, lo_27);
          {
            while ((mem.i32(k_15) < boundary_0)) {
              var X60Qtmp_153 = allocFixed(72);
              mem.copy(X60Qtmp_153, tok_0_parq39nt2(ps_75, mem.i32(k_15)), 72);
              var kk_4 = mem.u8At(X60Qtmp_153);
              var X60Qx_621;
              if ((kk_4 === 14)) {
                X60Qx_621 = (mem.i32(d_6) === 0);
              } else {
                X60Qx_621 = false;
              }
              if (X60Qx_621) {
                pragLo_4 = mem.i32(k_15);
                var X60Qx_622 = matchClose_0_parq39nt2(ps_75, mem.i32(k_15));
                pragHi_4 = X60Qx_622;
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_153);
                break whileStmtLabel_4;
              }
              var X60Qx_623 = isOpenBracket_0_parq39nt2(kk_4);
              if (X60Qx_623) {
                inc_1_I6wjjge_cmdqs323n1(d_6);
              } else {
                var X60Qx_624 = isCloseBracket_0_parq39nt2(kk_4);
                if (X60Qx_624) {
                  if ((0 < mem.i32(d_6))) {
                    dec_1_I0nzoz91_envto7w6l1(d_6);
                  }
                }
              }
              inc_1_I6wjjge_cmdqs323n1(k_15);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_153);
            }
          }
        }
      }
    }
    var X60Qx_36;
    if ((0 <= pragLo_4)) {
      X60Qx_36 = pragLo_4;
    } else {
      if ((0 <= colon_10)) {
        X60Qx_36 = colon_10;
      } else {
        if ((0 <= assign_1)) {
          X60Qx_36 = assign_1;
        } else {
          X60Qx_36 = hi_27;
        }
      }
    }
    var nameEnd_0 = X60Qx_36;
    var X60Qx_37;
    if ((0 <= colon_10)) {
      X60Qx_37 = ((colon_10 + 1) | 0);
    } else {
      X60Qx_37 = -1;
    }
    var typeLo_0 = X60Qx_37;
    var X60Qx_38;
    if ((0 <= colon_10)) {
      var X60Qx_39;
      if ((0 <= assign_1)) {
        X60Qx_39 = assign_1;
      } else {
        X60Qx_39 = hi_27;
      }
      X60Qx_38 = X60Qx_39;
    } else {
      X60Qx_38 = -1;
    }
    var typeHi_0 = X60Qx_38;
    var X60Qx_40;
    if ((0 <= assign_1)) {
      X60Qx_40 = ((assign_1 + 1) | 0);
    } else {
      X60Qx_40 = -1;
    }
    var valLo_0 = X60Qx_40;
    var nameStarts_0 = allocFixed(8);
    mem.copy(nameStarts_0, splitArgs_0_parq39nt2(ps_75, lo_27, nameEnd_0), 8);
    {
      whileStmtLabel_6: {
        var X60Qlf_56 = 0;
        var X60Qlf_57 = len_3_I0v1j8d_parq39nt2(nameStarts_0);
        var X60Qlf_58 = allocFixed(4);
        mem.setI32(X60Qlf_58, X60Qlf_56);
        {
          while ((mem.i32(X60Qlf_58) < X60Qlf_57)) {
            {
              var X60Qx_625 = getQ_7_Ir8kccm_parq39nt2(nameStarts_0, mem.i32(X60Qlf_58));
              var X60Qii_7 = allocFixed(72);
              mem.copy(X60Qii_7, tok_0_parq39nt2(ps_75, mem.i32(X60Qx_625)), 72);
              addTree_0_nifjp9lau1(b_59, tag_7);
              emitInfo_0_parq39nt2(ps_75, b_59, mem.i32((X60Qii_7 + 40)), mem.i32((X60Qii_7 + 44)), pl_54, pc_54, false);
              addIdent_0_nifjp9lau1(b_59, (X60Qii_7 + 4));
              emitInfo_0_parq39nt2(ps_75, b_59, mem.i32((X60Qii_7 + 40)), mem.i32((X60Qii_7 + 44)), mem.i32((X60Qii_7 + 40)), mem.i32((X60Qii_7 + 44)), false);
              var X60Qx_154;
              var X60Qx_155;
              var X60Qx_626 = getQ_7_Ir8kccm_parq39nt2(nameStarts_0, mem.i32(X60Qlf_58));
              if ((((mem.i32(X60Qx_626) + 1) | 0) < nameEnd_0)) {
                var X60Qx_627 = getQ_7_Ir8kccm_parq39nt2(nameStarts_0, mem.i32(X60Qlf_58));
                var X60Qtmp_154 = allocFixed(72);
                mem.copy(X60Qtmp_154, tok_0_parq39nt2(ps_75, ((mem.i32(X60Qx_627) + 1) | 0)), 72);
                X60Qx_155 = (mem.u8At(X60Qtmp_154) === 9);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_154);
              } else {
                X60Qx_155 = false;
              }
              if (X60Qx_155) {
                var X60Qx_628 = getQ_7_Ir8kccm_parq39nt2(nameStarts_0, mem.i32(X60Qlf_58));
                var X60Qtmp_155 = allocFixed(72);
                mem.copy(X60Qtmp_155, tok_0_parq39nt2(ps_75, ((mem.i32(X60Qx_628) + 1) | 0)), 72);
                var X60Qx_629 = eqQ_20_sysvq0asl((X60Qtmp_155 + 4), (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 10753);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
                X60Qx_154 = X60Qx_629;
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_155);
              } else {
                X60Qx_154 = false;
              }
              if (X60Qx_154) {
                addRaw_0_nifjp9lau1(b_59, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 7872514);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
              } else {
                addEmpty_0_nifjp9lau1(b_59, 1);
              }
              if ((0 <= pragLo_4)) {
                var X60Qx_630 = parsePragmas_1_parq39nt2(ps_75, b_59, pragLo_4, mem.i32((X60Qii_7 + 40)), mem.i32((X60Qii_7 + 44)));
              } else {
                addEmpty_0_nifjp9lau1(b_59, 1);
              }
              var X60Qx_631;
              if ((0 <= typeLo_0)) {
                X60Qx_631 = (typeLo_0 < typeHi_0);
              } else {
                X60Qx_631 = false;
              }
              if (X60Qx_631) {
                var X60Qii_8 = allocFixed(72);
                mem.copy(X60Qii_8, tok_0_parq39nt2(ps_75, typeLo_0), 72);
                var X60Qx_632;
                if ((mem.u8At(X60Qii_8) === 2)) {
                  var X60Qx_633;
                  var X60Qx_634;
                  var X60Qx_635 = eqQ_20_sysvq0asl((X60Qii_8 + 4), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1869771006);
                    mem.setU32((_o + 4), strlit_0_I5316556160589403975_parq39nt2);
                    return _o;
                  })());
                  if (X60Qx_635) {
                    X60Qx_634 = true;
                  } else {
                    var X60Qx_636 = eqQ_20_sysvq0asl((X60Qii_8 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1702128126);
                      mem.setU32((_o + 4), strlit_0_I9071657656589967445_parq39nt2);
                      return _o;
                    })());
                    X60Qx_634 = X60Qx_636;
                  }
                  if (X60Qx_634) {
                    X60Qx_633 = true;
                  } else {
                    var X60Qx_637 = eqQ_20_sysvq0asl((X60Qii_8 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1886745854);
                      mem.setU32((_o + 4), strlit_0_I18086024188298164462_parq39nt2);
                      return _o;
                    })());
                    X60Qx_633 = X60Qx_637;
                  }
                  X60Qx_632 = X60Qx_633;
                } else {
                  X60Qx_632 = false;
                }
                if (X60Qx_632) {
                  parseTypeRange_1_parq39nt2(ps_75, b_59, typeLo_0, typeHi_0, mem.i32((X60Qii_7 + 40)), mem.i32((X60Qii_7 + 44)));
                } else {
                  parseExprRange_1_parq39nt2(ps_75, b_59, typeLo_0, typeHi_0, mem.i32((X60Qii_7 + 40)), mem.i32((X60Qii_7 + 44)));
                }
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_8);
              } else {
                addEmpty_0_nifjp9lau1(b_59, 1);
              }
              var X60Qx_638;
              if ((0 <= valLo_0)) {
                X60Qx_638 = (valLo_0 < hi_27);
              } else {
                X60Qx_638 = false;
              }
              if (X60Qx_638) {
                var X60Qii_9 = allocFixed(72);
                mem.copy(X60Qii_9, tok_0_parq39nt2(ps_75, valLo_0), 72);
                var X60Qx_639;
                var X60Qx_640;
                var X60Qx_641 = len_3_I0v1j8d_parq39nt2(nameStarts_0);
                if ((X60Qx_641 === 1)) {
                  X60Qx_640 = (mem.u8At(X60Qii_9) === 2);
                } else {
                  X60Qx_640 = false;
                }
                if (X60Qx_640) {
                  var X60Qx_642;
                  var X60Qx_643;
                  var X60Qx_644;
                  var X60Qx_645;
                  var X60Qx_646 = eqQ_20_sysvq0asl((X60Qii_9 + 4), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 2037543939);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })());
                  if (X60Qx_646) {
                    X60Qx_645 = true;
                  } else {
                    var X60Qx_647 = eqQ_20_sysvq0asl((X60Qii_9 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 6711554);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                    X60Qx_645 = X60Qx_647;
                  }
                  if (X60Qx_645) {
                    X60Qx_644 = true;
                  } else {
                    var X60Qx_648 = eqQ_20_sysvq0asl((X60Qii_9 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1701345278);
                      mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
                      return _o;
                    })());
                    X60Qx_644 = X60Qx_648;
                  }
                  if (X60Qx_644) {
                    X60Qx_643 = true;
                  } else {
                    var X60Qx_649 = eqQ_20_sysvq0asl((X60Qii_9 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1935762430);
                      mem.setU32((_o + 4), strlit_0_I4956278306908871092_parq39nt2);
                      return _o;
                    })());
                    X60Qx_643 = X60Qx_649;
                  }
                  if (X60Qx_643) {
                    X60Qx_642 = true;
                  } else {
                    var X60Qx_650 = eqQ_20_sysvq0asl((X60Qii_9 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1869374206);
                      mem.setU32((_o + 4), strlit_0_I9830314142150548690_parq39nt2);
                      return _o;
                    })());
                    X60Qx_642 = X60Qx_650;
                  }
                  X60Qx_639 = X60Qx_642;
                } else {
                  X60Qx_639 = false;
                }
                if (X60Qx_639) {
                  var X60Qx_651 = parseCtrlFlowValue_0_parq39nt2(ps_75, b_59, valLo_0, mem.i32((X60Qii_7 + 40)), mem.i32((X60Qii_7 + 44)));
                  result_51 = X60Qx_651;
                } else {
                  parseExprRange_1_parq39nt2(ps_75, b_59, valLo_0, hi_27, mem.i32((X60Qii_7 + 40)), mem.i32((X60Qii_7 + 44)));
                }
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_9);
              } else {
                addEmpty_0_nifjp9lau1(b_59, 1);
              }
              endTree_0_nifjp9lau1(b_59);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_7);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_58);
          }
        }
      }
    }
  }
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(nameStarts_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_152);
  return result_51;
  eQdestroy_1_Iv9ij5i1_mat7cnfv21(nameStarts_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_152);
  return result_51;
}

function parseSection_0_parq39nt2(ps_76, b_60, kwIdx_16, pl_55, pc_55, tag_8) {
  var result_52;
  var kw_22 = allocFixed(72);
  mem.copy(kw_22, tok_0_parq39nt2(ps_76, kwIdx_16), 72);
  var next_0 = allocFixed(72);
  mem.copy(next_0, tok_0_parq39nt2(ps_76, ((kwIdx_16 + 1) | 0)), 72);
  if ((mem.u8At(next_0) === 0)) {
    result_52 = ((kwIdx_16 + 1) | 0);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(next_0);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_22);
    return result_52;
  }
  if ((0 <= mem.i32((next_0 + 52)))) {
    whileStmtLabel_0: {
      var refIndent_11 = mem.i32((kw_22 + 44));
      var i_38 = allocFixed(4);
      mem.setI32(i_38, ((kwIdx_16 + 1) | 0));
      {
        while (true) {
          var X60Qx_156;
          var X60Qtmp_156 = allocFixed(72);
          mem.copy(X60Qtmp_156, tok_0_parq39nt2(ps_76, mem.i32(i_38)), 72);
          if ((!(mem.u8At(X60Qtmp_156) === 0))) {
            var X60Qtmp_157 = allocFixed(72);
            mem.copy(X60Qtmp_157, tok_0_parq39nt2(ps_76, mem.i32(i_38)), 72);
            X60Qx_156 = (refIndent_11 < mem.i32((X60Qtmp_157 + 52)));
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_157);
          } else {
            X60Qx_156 = false;
          }
          if (X60Qx_156) {
            continueLabel_1: {
              {
                var X60Qtmp_158 = allocFixed(72);
                mem.copy(X60Qtmp_158, tok_0_parq39nt2(ps_76, mem.i32(i_38)), 72);
                if ((mem.u8At(X60Qtmp_158) === 20)) {
                  inc_1_I6wjjge_cmdqs323n1(i_38);
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_158);
                  break continueLabel_1;
                }
                var dhi_0 = lineEnd_0_parq39nt2(ps_76, mem.i32(i_38));
                var consumed_0 = parseSectionDef_0_parq39nt2(ps_76, b_60, mem.i32(i_38), dhi_0, tag_8, pl_55, pc_55);
                var X60Qx_41;
                if ((dhi_0 < consumed_0)) {
                  X60Qx_41 = consumed_0;
                } else {
                  X60Qx_41 = dhi_0;
                }
                mem.setI32(i_38, X60Qx_41);
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_158);
              }
            }
          } else {
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_156);
            break;
          }
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_156);
        }
      }
    }
    result_52 = mem.i32(i_38);
  } else {
    var X60Qx_652 = lineEnd_0_parq39nt2(ps_76, kwIdx_16);
    var hi_46 = semiEnd_0_parq39nt2(ps_76, kwIdx_16, X60Qx_652);
    var X60Qx_653 = parseSectionDef_0_parq39nt2(ps_76, b_60, ((kwIdx_16 + 1) | 0), hi_46, tag_8, pl_55, pc_55);
    result_52 = X60Qx_653;
  }
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(next_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_22);
  return result_52;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(next_0);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_22);
  return result_52;
}

function parsePragmaStmt_0_parq39nt2(ps_77, b_61, braceIdx_2, pl_56, pc_56) {
  let result_53;
  let brace_2 = allocFixed(72);
  mem.copy(brace_2, tok_0_parq39nt2(ps_77, braceIdx_2), 72);
  let rb_9 = matchClose_0_parq39nt2(ps_77, braceIdx_2);
  let X60Qtmp_159 = allocFixed(72);
  mem.copy(X60Qtmp_159, tok_0_parq39nt2(ps_77, ((rb_9 + 1) | 0)), 72);
  if ((mem.u8At(X60Qtmp_159) === 18)) {
    addTree_0_nifjp9lau1(b_61, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1634889982);
      mem.setU32((_o + 4), strlit_0_I17199005983847516849_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_77, b_61, mem.i32((brace_2 + 40)), mem.i32((brace_2 + 44)), pl_56, pc_56, false);
    let X60Qx_654 = parsePragmas_1_parq39nt2(ps_77, b_61, braceIdx_2, mem.i32((brace_2 + 40)), mem.i32((brace_2 + 44)));
    let X60Qx_655 = emitBody_0_parq39nt2(ps_77, b_61, ((rb_9 + 1) | 0), mem.i32((brace_2 + 44)), mem.i32((brace_2 + 40)), mem.i32((brace_2 + 44)));
    result_53 = X60Qx_655;
    endTree_0_nifjp9lau1(b_61);
  } else {
    let X60Qx_656 = parsePragmas_1_parq39nt2(ps_77, b_61, braceIdx_2, pl_56, pc_56);
    result_53 = X60Qx_656;
  }
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_159);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(brace_2);
  return result_53;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_159);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(brace_2);
  return result_53;
}

function parseFromImport_0_parq39nt2(ps_78, b_62, kwIdx_17, pl_57, pc_57) {
  whileStmtLabel_0: {
    var result_54;
    var kw_23 = allocFixed(72);
    mem.copy(kw_23, tok_0_parq39nt2(ps_78, kwIdx_17), 72);
    var X60Qx_657 = lineEnd_0_parq39nt2(ps_78, kwIdx_17);
    var hi_47 = semiEnd_0_parq39nt2(ps_78, kwIdx_17, X60Qx_657);
    var impIdx_0 = -1;
    var d_7 = allocFixed(4);
    mem.setI32(d_7, 0);
    var i_39 = allocFixed(4);
    mem.setI32(i_39, ((kwIdx_17 + 1) | 0));
    {
      while ((mem.i32(i_39) < hi_47)) {
        var t_22 = allocFixed(72);
        mem.copy(t_22, tok_0_parq39nt2(ps_78, mem.i32(i_39)), 72);
        var X60Qx_658 = isOpenBracket_0_parq39nt2(mem.u8At(t_22));
        if (X60Qx_658) {
          inc_1_I6wjjge_cmdqs323n1(d_7);
        } else {
          var X60Qx_659 = isCloseBracket_0_parq39nt2(mem.u8At(t_22));
          if (X60Qx_659) {
            if ((0 < mem.i32(d_7))) {
              dec_1_I0nzoz91_envto7w6l1(d_7);
            }
          } else {
            var X60Qx_660;
            var X60Qx_661;
            if ((mem.i32(d_7) === 0)) {
              X60Qx_661 = (mem.u8At(t_22) === 2);
            } else {
              X60Qx_661 = false;
            }
            if (X60Qx_661) {
              var X60Qx_662 = eqQ_20_sysvq0asl((t_22 + 4), (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1886218750);
                mem.setU32((_o + 4), strlit_0_I10578126245728228512_parq39nt2);
                return _o;
              })());
              X60Qx_660 = X60Qx_662;
            } else {
              X60Qx_660 = false;
            }
            if (X60Qx_660) {
              impIdx_0 = mem.i32(i_39);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_22);
              break whileStmtLabel_0;
            }
          }
        }
        inc_1_I6wjjge_cmdqs323n1(i_39);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_22);
      }
    }
  }
  addTree_0_nifjp9lau1(b_62, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 1869768446);
    mem.setU32((_o + 4), strlit_0_I3199637833187763350_parq39nt2);
    return _o;
  })());
  emitInfo_0_parq39nt2(ps_78, b_62, mem.i32((kw_23 + 40)), mem.i32((kw_23 + 44)), pl_57, pc_57, false);
  var X60Qx_42;
  if ((0 <= impIdx_0)) {
    X60Qx_42 = impIdx_0;
  } else {
    X60Qx_42 = hi_47;
  }
  var modHi_0 = X60Qx_42;
  if ((((kwIdx_17 + 1) | 0) < modHi_0)) {
    parseExprRange_1_parq39nt2(ps_78, b_62, ((kwIdx_17 + 1) | 0), modHi_0, mem.i32((kw_23 + 40)), mem.i32((kw_23 + 44)));
  } else {
    addEmpty_0_nifjp9lau1(b_62, 1);
  }
  if ((0 <= impIdx_0)) {
    forStmtLabel_1: {
      var starts_11 = allocFixed(8);
      mem.copy(starts_11, splitArgs_0_parq39nt2(ps_78, ((impIdx_0 + 1) | 0), hi_47), 8);
      {
        whileStmtLabel_2: {
          var X60Qlf_59 = 0;
          var X60Qlf_60 = len_3_I0v1j8d_parq39nt2(starts_11);
          var X60Qlf_61 = allocFixed(4);
          mem.setI32(X60Qlf_61, X60Qlf_59);
          {
            while ((mem.i32(X60Qlf_61) < X60Qlf_60)) {
              {
                var X60Qx_663 = getQ_7_Ir8kccm_parq39nt2(starts_11, mem.i32(X60Qlf_61));
                var X60Qii_3 = allocFixed(4);
                mem.setI32(X60Qii_3, mem.i32(X60Qx_663));
                var X60Qx_43;
                var X60Qx_664 = len_3_I0v1j8d_parq39nt2(starts_11);
                if ((((mem.i32(X60Qlf_61) + 1) | 0) < X60Qx_664)) {
                  var X60Qx_665 = getQ_7_Ir8kccm_parq39nt2(starts_11, ((mem.i32(X60Qlf_61) + 1) | 0));
                  X60Qx_43 = ((mem.i32(X60Qx_665) - 1) | 0);
                } else {
                  X60Qx_43 = hi_47;
                }
                var X60Qii_4 = X60Qx_43;
                if ((mem.i32(X60Qii_3) < X60Qii_4)) {
                  parseExprRange_1_parq39nt2(ps_78, b_62, mem.i32(X60Qii_3), X60Qii_4, mem.i32((kw_23 + 40)), mem.i32((kw_23 + 44)));
                }
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_61);
            }
          }
        }
      }
    }
    eQdestroy_1_Iv9ij5i1_mat7cnfv21(starts_11);
  }
  endTree_0_nifjp9lau1(b_62);
  result_54 = hi_47;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_23);
  return result_54;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_23);
  return result_54;
}

function parseStatic_0_parq39nt2(ps_79, b_63, kwIdx_18, pl_58, pc_58) {
  let result_55;
  let kw_24 = allocFixed(72);
  mem.copy(kw_24, tok_0_parq39nt2(ps_79, kwIdx_18), 72);
  addTree_0_nifjp9lau1(b_63, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1635021822);
    mem.setU32((_o + 4), strlit_0_I4843651051758684618_parq39nt2);
    return _o;
  })());
  emitInfo_0_parq39nt2(ps_79, b_63, mem.i32((kw_24 + 40)), mem.i32((kw_24 + 44)), pl_58, pc_58, false);
  let hi_48 = lineEnd_0_parq39nt2(ps_79, kwIdx_18);
  let colon_11 = findColon_0_parq39nt2(ps_79, kwIdx_18, hi_48);
  let X60Qx_666 = emitBody_0_parq39nt2(ps_79, b_63, colon_11, mem.i32((kw_24 + 44)), mem.i32((kw_24 + 40)), mem.i32((kw_24 + 44)));
  result_55 = X60Qx_666;
  endTree_0_nifjp9lau1(b_63);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_24);
  return result_55;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(kw_24);
  return result_55;
}

function semiEnd_0_parq39nt2(ps_80, startIdx_2, bound_0) {
  whileStmtLabel_0: {
    var result_56;
    var d_8 = allocFixed(4);
    mem.setI32(d_8, 0);
    var i_40 = allocFixed(4);
    mem.setI32(i_40, startIdx_2);
    {
      while ((mem.i32(i_40) < bound_0)) {
        var t_23 = allocFixed(72);
        mem.copy(t_23, tok_0_parq39nt2(ps_80, mem.i32(i_40)), 72);
        var X60Qx_667 = isOpenBracket_0_parq39nt2(mem.u8At(t_23));
        if (X60Qx_667) {
          inc_1_I6wjjge_cmdqs323n1(d_8);
        } else {
          var X60Qx_668 = isCloseBracket_0_parq39nt2(mem.u8At(t_23));
          if (X60Qx_668) {
            if ((0 < mem.i32(d_8))) {
              dec_1_I0nzoz91_envto7w6l1(d_8);
            }
          } else {
            var X60Qx_669;
            if ((mem.i32(d_8) === 0)) {
              X60Qx_669 = (mem.u8At(t_23) === 17);
            } else {
              X60Qx_669 = false;
            }
            if (X60Qx_669) {
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_23);
              return mem.i32(i_40);
            }
          }
        }
        inc_1_I6wjjge_cmdqs323n1(i_40);
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_23);
      }
    }
  }
  result_56 = bound_0;
  return result_56;
}

function parsePostExprBlock_0_parq39nt2(ps_81, b_64, headLo_0, colonIdx_2, pl_59, pc_59) {
  let result_57;
  let head_3 = allocFixed(72);
  mem.copy(head_3, tok_0_parq39nt2(ps_81, headLo_0), 72);
  let refIndent_12 = mem.i32((head_3 + 44));
  let ce_4 = cmdCalleeEnd_0_parq39nt2(ps_81, headLo_0, colonIdx_2);
  let X60Qx_670;
  let X60Qx_671;
  if ((mem.u8At(head_3) === 1)) {
    X60Qx_671 = (ce_4 < colonIdx_2);
  } else {
    X60Qx_671 = false;
  }
  if (X60Qx_671) {
    let X60Qx_672 = startsArg_0_parq39nt2(ps_81, ce_4, colonIdx_2);
    X60Qx_670 = X60Qx_672;
  } else {
    X60Qx_670 = false;
  }
  if (X60Qx_670) {
    addTree_0_nifjp9lau1(b_64, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1684890371);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_81, b_64, mem.i32((head_3 + 40)), mem.i32((head_3 + 44)), pl_59, pc_59, false);
    parseExprRange_1_parq39nt2(ps_81, b_64, headLo_0, ce_4, mem.i32((head_3 + 40)), mem.i32((head_3 + 44)));
    parseArgList_0_parq39nt2(ps_81, b_64, ce_4, colonIdx_2, mem.i32((head_3 + 40)), mem.i32((head_3 + 44)));
    let X60Qx_673 = emitBody_0_parq39nt2(ps_81, b_64, colonIdx_2, refIndent_12, mem.i32((head_3 + 40)), mem.i32((head_3 + 44)));
    result_57 = X60Qx_673;
    endTree_0_nifjp9lau1(b_64);
  } else {
    addTree_0_nifjp9lau1(b_64, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1818321918);
      mem.setU32((_o + 4), strlit_0_I1707222714195181991_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_81, b_64, mem.i32((head_3 + 40)), mem.i32((head_3 + 44)), pl_59, pc_59, false);
    let X60Qx_157;
    if ((headLo_0 <= ((colonIdx_2 - 1) | 0))) {
      let X60Qtmp_160 = allocFixed(72);
      mem.copy(X60Qtmp_160, tok_0_parq39nt2(ps_81, ((colonIdx_2 - 1) | 0)), 72);
      X60Qx_157 = (mem.u8At(X60Qtmp_160) === 11);
      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_160);
    } else {
      X60Qx_157 = false;
    }
    if (X60Qx_157) {
      let rparen_0 = ((colonIdx_2 - 1) | 0);
      let lparen_0 = matchOpen_0_parq39nt2(ps_81, rparen_0);
      parseExprRange_1_parq39nt2(ps_81, b_64, headLo_0, lparen_0, mem.i32((head_3 + 40)), mem.i32((head_3 + 44)));
      parseArgList_0_parq39nt2(ps_81, b_64, ((lparen_0 + 1) | 0), rparen_0, mem.i32((head_3 + 40)), mem.i32((head_3 + 44)));
    } else {
      parseExprRange_1_parq39nt2(ps_81, b_64, headLo_0, colonIdx_2, mem.i32((head_3 + 40)), mem.i32((head_3 + 44)));
    }
    let X60Qx_674 = emitBody_0_parq39nt2(ps_81, b_64, colonIdx_2, refIndent_12, mem.i32((head_3 + 40)), mem.i32((head_3 + 44)));
    result_57 = X60Qx_674;
    endTree_0_nifjp9lau1(b_64);
  }
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(head_3);
  return result_57;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(head_3);
  return result_57;
}

function parseOneStmt_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, hiLimit_1) {
  var result_58;
  var t_24 = allocFixed(72);
  mem.copy(t_24, tok_0_parq39nt2(ps_82, startIdx_3), 72);
  if ((mem.u8At(t_24) === 20)) {
    addTree_0_nifjp9lau1(b_65, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1836016638);
      mem.setU32((_o + 4), strlit_0_I18257730313531980409_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_82, b_65, mem.i32((t_24 + 40)), mem.i32((t_24 + 44)), pl_60, pc_60, false);
    endTree_0_nifjp9lau1(b_65);
    result_58 = ((startIdx_3 + 1) | 0);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
    return result_58;
  }
  var X60Qx_158;
  if ((mem.u8At(t_24) === 14)) {
    var X60Qtmp_161 = allocFixed(72);
    mem.copy(X60Qtmp_161, tok_0_parq39nt2(ps_82, ((startIdx_3 + 1) | 0)), 72);
    X60Qx_158 = (mem.u8At(X60Qtmp_161) === 19);
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_161);
  } else {
    X60Qx_158 = false;
  }
  if (X60Qx_158) {
    var X60Qx_675 = parsePragmaStmt_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60);
    result_58 = X60Qx_675;
    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
    return result_58;
  }
  if ((mem.u8At(t_24) === 2)) {
    X60Qsc_71: {
      X60Qsc_72: {
        X60Qsc_55: {
          X60Qsc_54: {
            X60Qsc_53: {
              X60Qsc_52: {
                X60Qsc_51: {
                  X60Qsc_50: {
                    X60Qsc_49: {
                      X60Qsc_48: {
                        X60Qsc_47: {
                          X60Qsc_46: {
                            X60Qsc_45: {
                              X60Qsc_44: {
                                X60Qsc_43: {
                                  X60Qsc_42: {
                                    X60Qsc_41: {
                                      X60Qsc_40: {
                                        X60Qsc_39: {
                                          X60Qsc_38: {
                                            X60Qsc_37: {
                                              X60Qsc_36: {
                                                X60Qsc_35: {
                                                  X60Qsc_34: {
                                                    X60Qsc_33: {
                                                      X60Qsc_32: {
                                                        X60Qsc_31: {
                                                          X60Qsc_30: {
                                                            X60Qsc_29: {
                                                              X60Qsc_28: {
                                                                X60Qsc_27: {
                                                                  X60Qsc_26: {
                                                                    var X60Qtc_25 = allocFixed(8);
                                                                    mem.copy(X60Qtc_25, (t_24 + 4), 8);
                                                                    var X60Qtc_56 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 1, 108);
                                                                    if (X60Qtc_56) {
                                                                      var X60Qtc_57 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 0, 109);
                                                                      if (X60Qtc_57) {
                                                                        var X60Qtc_58 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 0, 100);
                                                                        if (X60Qtc_58) {
                                                                          var X60Qtc_59 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 0, 99);
                                                                          if (X60Qtc_59) {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1935762430);
                                                                              mem.setU32((_o + 4), strlit_0_I4956278306908871092_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_45;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1869374206);
                                                                              mem.setU32((_o + 4), strlit_0_I9830314142150548690_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_48;
                                                                            }
                                                                          } else {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1936286974);
                                                                              mem.setU32((_o + 4), strlit_0_I2956720964102846418_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_34;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1717921022);
                                                                              mem.setU32((_o + 4), strlit_0_I4167773820130397069_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_51;
                                                                            }
                                                                          }
                                                                        } else {
                                                                          var X60Qtc_60 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 0, 108);
                                                                          if (X60Qtc_60) {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 6711554);
                                                                              mem.setU32((_o + 4), 0);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_42;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1952803843);
                                                                              mem.setU32((_o + 4), 0);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_53;
                                                                            }
                                                                          } else {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1952804350);
                                                                              mem.setU32((_o + 4), strlit_0_I6517805684605582485_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_28;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1667329534);
                                                                              mem.setU32((_o + 4), strlit_0_I3777428167486794959_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_31;
                                                                            }
                                                                          }
                                                                        }
                                                                      } else {
                                                                        var X60Qtc_61 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 0, 116);
                                                                        if (X60Qtc_61) {
                                                                          var X60Qtc_62 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 0, 114);
                                                                          if (X60Qtc_62) {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1952805630);
                                                                              mem.setU32((_o + 4), strlit_0_I12427448230105600699_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_33;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1767994110);
                                                                              mem.setU32((_o + 4), strlit_0_I6137881024046402116_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_35;
                                                                            }
                                                                          } else {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1835365630);
                                                                              mem.setU32((_o + 4), strlit_0_I17987658270787974407_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_32;
                                                                            }
                                                                          }
                                                                        } else {
                                                                          var X60Qtc_63 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 2, 101);
                                                                          if (X60Qtc_63) {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1701411326);
                                                                              mem.setU32((_o + 4), strlit_0_I16137783760080910327_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_36;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1701345278);
                                                                              mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_43;
                                                                            }
                                                                          } else {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1768454142);
                                                                              mem.setU32((_o + 4), strlit_0_I13200118161122656888_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_44;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1918989827);
                                                                              mem.setU32((_o + 4), 0);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_52;
                                                                            }
                                                                          }
                                                                        }
                                                                      }
                                                                    } else {
                                                                      var X60Qtc_64 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 0, 102);
                                                                      if (X60Qtc_64) {
                                                                        var X60Qtc_65 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 0, 99);
                                                                        if (X60Qtc_65) {
                                                                          var X60Qtc_66 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 3, 115);
                                                                          if (X60Qtc_66) {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1701995262);
                                                                              mem.setU32((_o + 4), strlit_0_I8380221545607033154_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_49;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1852793854);
                                                                              mem.setU32((_o + 4), strlit_0_I12999086881046019782_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_54;
                                                                            }
                                                                          } else {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1852793854);
                                                                              mem.setU32((_o + 4), strlit_0_I6864681898360807206_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_29;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1852793854);
                                                                              mem.setU32((_o + 4), strlit_0_I2210116261907819816_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_50;
                                                                            }
                                                                          }
                                                                        } else {
                                                                          var X60Qtc_67 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 1, 114);
                                                                          if (X60Qtc_67) {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1869768446);
                                                                              mem.setU32((_o + 4), strlit_0_I15371509460875483150_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_40;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1919903235);
                                                                              mem.setU32((_o + 4), 0);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_46;
                                                                            }
                                                                          } else {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1853187838);
                                                                              mem.setU32((_o + 4), strlit_0_I9991102891510134496_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_27;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1886938622);
                                                                              mem.setU32((_o + 4), strlit_0_I6313045265747232047_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_39;
                                                                            }
                                                                          }
                                                                        }
                                                                      } else {
                                                                        var X60Qtc_68 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 0, 112);
                                                                        if (X60Qtc_68) {
                                                                          var X60Qtc_69 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 1, 110);
                                                                          if (X60Qtc_69) {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1886218750);
                                                                              mem.setU32((_o + 4), strlit_0_I10578126245728228512_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_37;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1668180478);
                                                                              mem.setU32((_o + 4), strlit_0_I3312144845751804851_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_38;
                                                                            }
                                                                          } else {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1869771006);
                                                                              mem.setU32((_o + 4), strlit_0_I5316556160589403975_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_26;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1702128126);
                                                                              mem.setU32((_o + 4), strlit_0_I9071657656589967445_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_30;
                                                                            }
                                                                          }
                                                                        } else {
                                                                          var X60Qtc_70 = nimStrAtLe_0_sysvq0asl(X60Qtc_25, 0, 115);
                                                                          if (X60Qtc_70) {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1635021822);
                                                                              mem.setU32((_o + 4), strlit_0_I17569086427026686584_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_41;
                                                                            }
                                                                          } else {
                                                                            if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 2037543939);
                                                                              mem.setU32((_o + 4), 0);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_47;
                                                                            } else if (equalStrings_0_sysvq0asl(X60Qtc_25, (() => {
                                                                              var _o = allocFixed(8);
                                                                              mem.setU32(_o, 1887007998);
                                                                              mem.setU32((_o + 4), strlit_0_I13413619771642637377_parq39nt2);
                                                                              return _o;
                                                                            })())) {
                                                                              break X60Qsc_55;
                                                                            }
                                                                          }
                                                                        }
                                                                      }
                                                                    }
                                                                    break X60Qsc_72;
                                                                  }
                                                                  var X60Qx_676 = parseRoutine_1_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                                                    var _o = allocFixed(8);
                                                                    mem.setU32(_o, 1869771006);
                                                                    mem.setU32((_o + 4), strlit_0_I5316556160589403975_parq39nt2);
                                                                    return _o;
                                                                  })());
                                                                  result_58 = X60Qx_676;
                                                                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                                                  return result_58;
                                                                  break X60Qsc_71;
                                                                }
                                                                var X60Qx_677 = parseRoutine_1_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                                                  var _o = allocFixed(8);
                                                                  mem.setU32(_o, 1853187838);
                                                                  mem.setU32((_o + 4), strlit_0_I9991102891510134496_parq39nt2);
                                                                  return _o;
                                                                })());
                                                                result_58 = X60Qx_677;
                                                                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                                                return result_58;
                                                                break X60Qsc_71;
                                                              }
                                                              var X60Qx_678 = parseRoutine_1_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                                                var _o = allocFixed(8);
                                                                mem.setU32(_o, 1952804350);
                                                                mem.setU32((_o + 4), strlit_0_I6517805684605582485_parq39nt2);
                                                                return _o;
                                                              })());
                                                              result_58 = X60Qx_678;
                                                              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                                              return result_58;
                                                              break X60Qsc_71;
                                                            }
                                                            var X60Qx_679 = parseRoutine_1_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                                              var _o = allocFixed(8);
                                                              mem.setU32(_o, 1852793854);
                                                              mem.setU32((_o + 4), strlit_0_I6864681898360807206_parq39nt2);
                                                              return _o;
                                                            })());
                                                            result_58 = X60Qx_679;
                                                            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                                            return result_58;
                                                            break X60Qsc_71;
                                                          }
                                                          var X60Qx_680 = parseRoutine_1_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                                            var _o = allocFixed(8);
                                                            mem.setU32(_o, 1702128126);
                                                            mem.setU32((_o + 4), strlit_0_I9071657656589967445_parq39nt2);
                                                            return _o;
                                                          })());
                                                          result_58 = X60Qx_680;
                                                          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                                          return result_58;
                                                          break X60Qsc_71;
                                                        }
                                                        var X60Qx_681 = parseRoutine_1_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                                          var _o = allocFixed(8);
                                                          mem.setU32(_o, 1667329534);
                                                          mem.setU32((_o + 4), strlit_0_I3777428167486794959_parq39nt2);
                                                          return _o;
                                                        })());
                                                        result_58 = X60Qx_681;
                                                        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                                        return result_58;
                                                        break X60Qsc_71;
                                                      }
                                                      var X60Qx_682 = parseRoutine_1_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                                        var _o = allocFixed(8);
                                                        mem.setU32(_o, 1835365630);
                                                        mem.setU32((_o + 4), strlit_0_I17987658270787974407_parq39nt2);
                                                        return _o;
                                                      })());
                                                      result_58 = X60Qx_682;
                                                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                                      return result_58;
                                                      break X60Qsc_71;
                                                    }
                                                    var X60Qx_683 = parseReturnLike_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                                      var _o = allocFixed(8);
                                                      mem.setU32(_o, 1952805379);
                                                      mem.setU32((_o + 4), 0);
                                                      return _o;
                                                    })());
                                                    result_58 = X60Qx_683;
                                                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                                    return result_58;
                                                    break X60Qsc_71;
                                                  }
                                                  var X60Qx_684 = parseReturnLike_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                                    var _o = allocFixed(8);
                                                    mem.setU32(_o, 1936286974);
                                                    mem.setU32((_o + 4), strlit_0_I2956720964102846418_parq39nt2);
                                                    return _o;
                                                  })());
                                                  result_58 = X60Qx_684;
                                                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                                  return result_58;
                                                  break X60Qsc_71;
                                                }
                                                var X60Qx_685 = parseReturnLike_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                                  var _o = allocFixed(8);
                                                  mem.setU32(_o, 1767994110);
                                                  mem.setU32((_o + 4), strlit_0_I6137881024046402116_parq39nt2);
                                                  return _o;
                                                })());
                                                result_58 = X60Qx_685;
                                                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                                return result_58;
                                                break X60Qsc_71;
                                              }
                                              var X60Qx_686 = parseReturnLike_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                                var _o = allocFixed(8);
                                                mem.setU32(_o, 1684830467);
                                                mem.setU32((_o + 4), 0);
                                                return _o;
                                              })());
                                              result_58 = X60Qx_686;
                                              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                              return result_58;
                                              break X60Qsc_71;
                                            }
                                            var X60Qx_687 = parseImportLike_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                              var _o = allocFixed(8);
                                              mem.setU32(_o, 1886218750);
                                              mem.setU32((_o + 4), strlit_0_I10578126245728228512_parq39nt2);
                                              return _o;
                                            })());
                                            result_58 = X60Qx_687;
                                            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                            return result_58;
                                            break X60Qsc_71;
                                          }
                                          var X60Qx_688 = parseImportLike_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                            var _o = allocFixed(8);
                                            mem.setU32(_o, 1668180478);
                                            mem.setU32((_o + 4), strlit_0_I3312144845751804851_parq39nt2);
                                            return _o;
                                          })());
                                          result_58 = X60Qx_688;
                                          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                          return result_58;
                                          break X60Qsc_71;
                                        }
                                        var X60Qx_689 = parseImportLike_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                          var _o = allocFixed(8);
                                          mem.setU32(_o, 1886938622);
                                          mem.setU32((_o + 4), strlit_0_I6313045265747232047_parq39nt2);
                                          return _o;
                                        })());
                                        result_58 = X60Qx_689;
                                        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                        return result_58;
                                        break X60Qsc_71;
                                      }
                                      var X60Qx_690 = parseFromImport_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60);
                                      result_58 = X60Qx_690;
                                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                      return result_58;
                                      break X60Qsc_71;
                                    }
                                    var X60Qx_691 = parseStatic_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60);
                                    result_58 = X60Qx_691;
                                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                    return result_58;
                                    break X60Qsc_71;
                                  }
                                  var X60Qx_692 = parseIfLike_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                    var _o = allocFixed(8);
                                    mem.setU32(_o, 6711554);
                                    mem.setU32((_o + 4), 0);
                                    return _o;
                                  })());
                                  result_58 = X60Qx_692;
                                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                  return result_58;
                                  break X60Qsc_71;
                                }
                                var X60Qx_693 = parseIfLike_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                                  var _o = allocFixed(8);
                                  mem.setU32(_o, 1701345278);
                                  mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
                                  return _o;
                                })());
                                result_58 = X60Qx_693;
                                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                                return result_58;
                                break X60Qsc_71;
                              }
                              var X60Qx_694 = parseWhile_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60);
                              result_58 = X60Qx_694;
                              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                              return result_58;
                              break X60Qsc_71;
                            }
                            var X60Qx_695 = parseCase_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60);
                            result_58 = X60Qx_695;
                            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                            return result_58;
                            break X60Qsc_71;
                          }
                          var X60Qx_696 = parseFor_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60);
                          result_58 = X60Qx_696;
                          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                          return result_58;
                          break X60Qsc_71;
                        }
                        var X60Qx_697 = parseTry_1_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60);
                        result_58 = X60Qx_697;
                        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                        return result_58;
                        break X60Qsc_71;
                      }
                      var X60Qx_698 = parseBlock_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60);
                      result_58 = X60Qx_698;
                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                      return result_58;
                      break X60Qsc_71;
                    }
                    var X60Qx_699 = parseBreakLike_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1701995262);
                      mem.setU32((_o + 4), strlit_0_I8380221545607033154_parq39nt2);
                      return _o;
                    })());
                    result_58 = X60Qx_699;
                    eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                    return result_58;
                    break X60Qsc_71;
                  }
                  var X60Qx_700 = parseBreakLike_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 1852793854);
                    mem.setU32((_o + 4), strlit_0_I2210116261907819816_parq39nt2);
                    return _o;
                  })());
                  result_58 = X60Qx_700;
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                  return result_58;
                  break X60Qsc_71;
                }
                var X60Qx_701 = parseDefer_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60);
                result_58 = X60Qx_701;
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
                return result_58;
                break X60Qsc_71;
              }
              var X60Qx_702 = parseSection_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1918989827);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              result_58 = X60Qx_702;
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
              return result_58;
              break X60Qsc_71;
            }
            var X60Qx_703 = parseSection_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1952803843);
              mem.setU32((_o + 4), 0);
              return _o;
            })());
            result_58 = X60Qx_703;
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
            return result_58;
            break X60Qsc_71;
          }
          var X60Qx_704 = parseSection_0_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60, (() => {
            var _o = allocFixed(8);
            mem.setU32(_o, 1852793854);
            mem.setU32((_o + 4), strlit_0_I12999086881046019782_parq39nt2);
            return _o;
          })());
          result_58 = X60Qx_704;
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
          return result_58;
          break X60Qsc_71;
        }
        var X60Qx_705 = parseTypeSection_1_parq39nt2(ps_82, b_65, startIdx_3, pl_60, pc_60);
        result_58 = X60Qx_705;
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
        return result_58;
        break X60Qsc_71;
      }
    }
  }
  if ((hiLimit_1 < 0)) {
    var lineHi_2 = lineEnd_0_parq39nt2(ps_82, startIdx_3);
    var pcolon_0 = depth0Colon_0_parq39nt2(ps_82, startIdx_3, lineHi_2);
    var X60Qx_706;
    if ((startIdx_3 < pcolon_0)) {
      var X60Qx_707 = findAssign_0_parq39nt2(ps_82, startIdx_3, pcolon_0);
      X60Qx_706 = (X60Qx_707 < 0);
    } else {
      X60Qx_706 = false;
    }
    if (X60Qx_706) {
      whileStmtLabel_0: {
        var cf_0 = false;
        var d_9 = allocFixed(4);
        mem.setI32(d_9, 0);
        var k_16 = allocFixed(4);
        mem.setI32(k_16, startIdx_3);
        {
          while ((mem.i32(k_16) < pcolon_0)) {
            var t_25 = allocFixed(72);
            mem.copy(t_25, tok_0_parq39nt2(ps_82, mem.i32(k_16)), 72);
            var X60Qx_708 = isOpenBracket_0_parq39nt2(mem.u8At(t_25));
            if (X60Qx_708) {
              inc_1_I6wjjge_cmdqs323n1(d_9);
            } else {
              var X60Qx_709 = isCloseBracket_0_parq39nt2(mem.u8At(t_25));
              if (X60Qx_709) {
                if ((0 < mem.i32(d_9))) {
                  dec_1_I0nzoz91_envto7w6l1(d_9);
                }
              } else {
                var X60Qx_710;
                var X60Qx_711;
                if ((mem.i32(d_9) === 0)) {
                  X60Qx_711 = (mem.u8At(t_25) === 2);
                } else {
                  X60Qx_711 = false;
                }
                if (X60Qx_711) {
                  var X60Qx_712;
                  var X60Qx_713;
                  var X60Qx_714;
                  var X60Qx_715;
                  var X60Qx_716;
                  var X60Qx_717 = eqQ_20_sysvq0asl((t_25 + 4), (() => {
                    var _o = allocFixed(8);
                    mem.setU32(_o, 6711554);
                    mem.setU32((_o + 4), 0);
                    return _o;
                  })());
                  if (X60Qx_717) {
                    X60Qx_716 = true;
                  } else {
                    var X60Qx_718 = eqQ_20_sysvq0asl((t_25 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1701345278);
                      mem.setU32((_o + 4), strlit_0_I14781640258047403316_parq39nt2);
                      return _o;
                    })());
                    X60Qx_716 = X60Qx_718;
                  }
                  if (X60Qx_716) {
                    X60Qx_715 = true;
                  } else {
                    var X60Qx_719 = eqQ_20_sysvq0asl((t_25 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1935762430);
                      mem.setU32((_o + 4), strlit_0_I4956278306908871092_parq39nt2);
                      return _o;
                    })());
                    X60Qx_715 = X60Qx_719;
                  }
                  if (X60Qx_715) {
                    X60Qx_714 = true;
                  } else {
                    var X60Qx_720 = eqQ_20_sysvq0asl((t_25 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1768711678);
                      mem.setU32((_o + 4), strlit_0_I13424873862977158440_parq39nt2);
                      return _o;
                    })());
                    X60Qx_714 = X60Qx_720;
                  }
                  if (X60Qx_714) {
                    X60Qx_713 = true;
                  } else {
                    var X60Qx_721 = eqQ_20_sysvq0asl((t_25 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 1936483838);
                      mem.setU32((_o + 4), strlit_0_I4167480082662538754_parq39nt2);
                      return _o;
                    })());
                    X60Qx_713 = X60Qx_721;
                  }
                  if (X60Qx_713) {
                    X60Qx_712 = true;
                  } else {
                    var X60Qx_722 = eqQ_20_sysvq0asl((t_25 + 4), (() => {
                      var _o = allocFixed(8);
                      mem.setU32(_o, 6713090);
                      mem.setU32((_o + 4), 0);
                      return _o;
                    })());
                    X60Qx_712 = X60Qx_722;
                  }
                  X60Qx_710 = X60Qx_712;
                } else {
                  X60Qx_710 = false;
                }
                if (X60Qx_710) {
                  cf_0 = true;
                  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_25);
                  break whileStmtLabel_0;
                }
              }
            }
            inc_1_I6wjjge_cmdqs323n1(k_16);
            eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_25);
          }
        }
      }
      if ((!cf_0)) {
        var X60Qx_723 = parsePostExprBlock_0_parq39nt2(ps_82, b_65, startIdx_3, pcolon_0, pl_60, pc_60);
        result_58 = X60Qx_723;
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
        return result_58;
      }
    }
  }
  var bound_1 = lineEnd_0_parq39nt2(ps_82, startIdx_3);
  var X60Qx_724;
  if ((0 <= hiLimit_1)) {
    X60Qx_724 = (hiLimit_1 < bound_1);
  } else {
    X60Qx_724 = false;
  }
  if (X60Qx_724) {
    bound_1 = hiLimit_1;
  }
  var hi_49 = semiEnd_0_parq39nt2(ps_82, startIdx_3, bound_1);
  var consumed_1 = parseExprStmt_0_parq39nt2(ps_82, b_65, startIdx_3, hi_49, pl_60, pc_60);
  var X60Qx_44;
  if ((hi_49 < consumed_1)) {
    X60Qx_44 = consumed_1;
  } else {
    X60Qx_44 = hi_49;
  }
  result_58 = X60Qx_44;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
  return result_58;
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_24);
  return result_58;
}

function parseStmt_1_parq39nt2(ps_83, b_66, startIdx_4, pl_61, pc_61, hiLimit_2) {
  whileStmtLabel_0: {
    var result_59;
    var i_41 = parseOneStmt_0_parq39nt2(ps_83, b_66, startIdx_4, pl_61, pc_61, hiLimit_2);
    var bound_2 = lineEnd_0_parq39nt2(ps_83, startIdx_4);
    var X60Qx_725;
    if ((0 <= hiLimit_2)) {
      X60Qx_725 = (hiLimit_2 < bound_2);
    } else {
      X60Qx_725 = false;
    }
    if (X60Qx_725) {
      bound_2 = hiLimit_2;
    }
    {
      while (true) {
        var X60Qx_159;
        var X60Qtmp_162 = allocFixed(72);
        mem.copy(X60Qtmp_162, tok_0_parq39nt2(ps_83, i_41), 72);
        if ((mem.u8At(X60Qtmp_162) === 17)) {
          X60Qx_159 = (((i_41 + 1) | 0) < bound_2);
        } else {
          X60Qx_159 = false;
        }
        if (X60Qx_159) {
          var X60Qx_726 = parseOneStmt_0_parq39nt2(ps_83, b_66, ((i_41 + 1) | 0), pl_61, pc_61, hiLimit_2);
          i_41 = X60Qx_726;
        } else {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_162);
          break;
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_162);
      }
    }
  }
  result_59 = i_41;
  return result_59;
}

function parseModule_0_parq39nt2(ps_84, b_67) {
  whileStmtLabel_0: {
    addHeader_0_nifjp9lau1(b_67, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1718185726);
      mem.setU32((_o + 4), strlit_0_I16958549946995210046_parq39nt2);
      return _o;
    })(), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1835626238);
      mem.setU32((_o + 4), strlit_0_I15261117590630161161_parq39nt2);
      return _o;
    })());
    addTree_0_nifjp9lau1(b_67, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1836348414);
      mem.setU32((_o + 4), strlit_0_I13752166055203769914_parq39nt2);
      return _o;
    })());
    emitInfo_0_parq39nt2(ps_84, b_67, 1, 0, 0, 0, true);
    var i_42 = 0;
    {
      while (true) {
        var X60Qtmp_163 = allocFixed(72);
        mem.copy(X60Qtmp_163, tok_0_parq39nt2(ps_84, i_42), 72);
        if ((!(mem.u8At(X60Qtmp_163) === 0))) {
          var t_26 = allocFixed(72);
          mem.copy(t_26, tok_0_parq39nt2(ps_84, i_42), 72);
          var X60Qx_727;
          if ((mem.u8At(t_26) === 2)) {
            var X60Qx_728 = eqQ_20_sysvq0asl((t_26 + 4), (() => {
              var _o = allocFixed(8);
              mem.setU32(_o, 1887007998);
              mem.setU32((_o + 4), strlit_0_I13413619771642637377_parq39nt2);
              return _o;
            })());
            X60Qx_727 = X60Qx_728;
          } else {
            X60Qx_727 = false;
          }
          if (X60Qx_727) {
            var X60Qx_729 = parseTypeSection_1_parq39nt2(ps_84, b_67, i_42, 1, 0);
            i_42 = X60Qx_729;
          } else {
            var X60Qx_730 = parseStmt_1_parq39nt2(ps_84, b_67, i_42, 1, 0, -1);
            i_42 = X60Qx_730;
          }
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(t_26);
        } else {
          eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_163);
          break;
        }
        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_163);
      }
    }
  }
  endTree_0_nifjp9lau1(b_67);
}

function toOpenArray_1_I6b60gk1_parq39nt2(s_16) {
  let result_62 = allocFixed(8);
  let X60Qx_732 = rawData_0_I65w5sr_parq39nt2(s_16);
  mem.copy(result_62, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, X60Qx_732);
    mem.setI32((_o + 4), mem.i32(s_16));
    return _o;
  })(), 8);
  return result_62;
}

function toOpenArray_0_Ishwcxp1_parq39nt2(x_7) {
  let result_63 = allocFixed(8);
  let X60Qx_45 = allocFixed(8);
  if (((((13 | 0) + 1) | 0) === 0)) {
    mem.copy(X60Qx_45, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    mem.copy(X60Qx_45, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, x_7);
      mem.setI32((_o + 4), (((13 | 0) + 1) | 0));
      return _o;
    })(), 8);
  }
  mem.copy(result_63, X60Qx_45, 8);
  return result_63;
}

function add_0_I8kd4i4_parq39nt2(s_18, elem_3) {
  let L_0 = mem.i32(s_18);
  let X60Qx_735 = capInBytes_0_Iet286n_mat7cnfv21(s_18);
  if ((X60Qx_735 < ((Math.imul(L_0, 4) + 4) | 0))) {
    let X60Qx_736 = resize_0_I8l4tya_parq39nt2(s_18, 1);
    if ((!X60Qx_736)) {
      return;
    }
  }
  inc_1_I6wjjge_cmdqs323n1(s_18);
  mem.setI32((mem.u32((s_18 + 4)) + (L_0 * 4)), elem_3);
}

function len_3_I0v1j8d_parq39nt2(s_20) {
  let result_65;
  result_65 = mem.i32(s_20);
  return result_65;
}

function getQ_7_Ir8kccm_parq39nt2(s_21, i_46) {
  let X60Qx_737;
  if ((i_46 < mem.i32(s_21))) {
    X60Qx_737 = (0 <= i_46);
  } else {
    X60Qx_737 = false;
  }
  if ((!X60Qx_737)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_66;
  result_66 = (mem.u32((s_21 + 4)) + (i_46 * 4));
  return result_66;
}

function toOpenArray_1_I6ofx191_parq39nt2(s_24) {
  let result_68 = allocFixed(8);
  let X60Qx_742 = rawData_0_Ilu0q8c1_parq39nt2(s_24);
  mem.copy(result_68, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, X60Qx_742);
    mem.setI32((_o + 4), mem.i32(s_24));
    return _o;
  })(), 8);
  return result_68;
}

function newSeqUninit_0_I5mozxi1_parq39nt2(size_7) {
  let result_69 = allocFixed(8);
  if ((size_7 === 0)) {
    mem.copy(result_69, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_7);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_2 = memSizeInBytes_0_Ih4q01h_parq39nt2(size_7);
    let X60Qx_743 = alloc_1_sysvq0asl(memSize_2);
    mem.copy(result_69, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_7);
      mem.setU32((_o + 4), X60Qx_743);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_69 + 4)) === 0))) {
      let X60Qx_744 = allocFixed(8);
      mem.setU32(X60Qx_744, 1634036990);
      mem.setU32((X60Qx_744 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_69, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_2);
    }
  }
  return result_69;
}

function add_0_Irnc3p1_parq39nt2(s_26, elem_5) {
  let L_2 = mem.i32(s_26);
  let X60Qx_745 = capInBytes_0_In1m6ni_parq39nt2(s_26);
  if ((X60Qx_745 < ((Math.imul(L_2, 1) + 1) | 0))) {
    let X60Qx_746 = resize_0_I2yw78g1_parq39nt2(s_26, 1);
    if ((!X60Qx_746)) {
      return;
    }
  }
  inc_1_I6wjjge_cmdqs323n1(s_26);
  mem.setU8((mem.u32((s_26 + 4)) + L_2), elem_5);
}

function getQ_7_Iul1no9_parq39nt2(s_28, i_48) {
  let X60Qx_747;
  if ((i_48 < mem.i32(s_28))) {
    X60Qx_747 = (0 <= i_48);
  } else {
    X60Qx_747 = false;
  }
  if ((!X60Qx_747)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_70;
  result_70 = (mem.u32((s_28 + 4)) + i_48);
  return result_70;
}

function rawData_0_I65w5sr_parq39nt2(s_29) {
  let result_71;
  result_71 = mem.u32((s_29 + 4));
  return result_71;
}

function resize_0_I8l4tya_parq39nt2(dest_3, addedElements_3) {
  let result_76;
  let X60Qx_750 = capInBytes_0_Iet286n_mat7cnfv21(dest_3);
  let oldCap_0 = Math.trunc((X60Qx_750 / 4));
  let newCap_0 = recalcCap_0_sysvq0asl(oldCap_0, addedElements_3);
  let memSize_3 = memSizeInBytes_0_Inv7kg3_mat7cnfv21(newCap_0);
  let X60Qx_751 = realloc_1_sysvq0asl(mem.u32((dest_3 + 4)), memSize_3);
  mem.setU32((dest_3 + 4), X60Qx_751);
  if ((mem.u32((dest_3 + 4)) === 0)) {
    mem.setI32(dest_3, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_3);
    result_76 = false;
  } else {
    result_76 = true;
  }
  return result_76;
}

function rawData_0_Ilu0q8c1_parq39nt2(s_32) {
  let result_80;
  result_80 = mem.u32((s_32 + 4));
  return result_80;
}

function len_6_Inwgz45_parq39nt2(a_9) {
  let result_81;
  result_81 = mem.i32((a_9 + 4));
  return result_81;
}

function getQ_10_Iplfojn1_parq39nt2(x_11, idx_6) {
  let X60Qx_755;
  if ((0 <= idx_6)) {
    X60Qx_755 = (idx_6 < mem.i32((x_11 + 4)));
  } else {
    X60Qx_755 = false;
  }
  if ((!X60Qx_755)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14694606176902936784_has9tn57v);
      return _o;
    })());
  }
  let result_82;
  result_82 = (mem.u32(x_11) + (idx_6 * 72));
  return result_82;
}

function memSizeInBytes_0_Ih4q01h_parq39nt2(size_11) {
  let result_83;
  let X60QconstRefTemp_0 = allocFixed(4);
  mem.setI32(X60QconstRefTemp_0, Math.imul(size_11, 1));
  result_83 = mem.i32(X60QconstRefTemp_0);
  if (false) {
    result_83 = 2147483647;
  }
  return result_83;
}

function capInBytes_0_In1m6ni_parq39nt2(s_33) {
  let result_84;
  let X60Qx_48;
  if ((!(mem.u32((s_33 + 4)) === 0))) {
    let X60Qx_756 = allocatedSize_0_sysvq0asl(mem.u32((s_33 + 4)));
    X60Qx_48 = X60Qx_756;
  } else {
    X60Qx_48 = 0;
  }
  result_84 = X60Qx_48;
  return result_84;
}

function resize_0_I2yw78g1_parq39nt2(dest_5, addedElements_5) {
  let result_85;
  let X60Qx_757 = capInBytes_0_In1m6ni_parq39nt2(dest_5);
  let oldCap_2 = Math.trunc((X60Qx_757 / 1));
  let newCap_2 = recalcCap_0_sysvq0asl(oldCap_2, addedElements_5);
  let memSize_5 = memSizeInBytes_0_Ih4q01h_parq39nt2(newCap_2);
  let X60Qx_758 = realloc_1_sysvq0asl(mem.u32((dest_5 + 4)), memSize_5);
  mem.setU32((dest_5 + 4), X60Qx_758);
  if ((mem.u32((dest_5 + 4)) === 0)) {
    mem.setI32(dest_5, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_5);
    result_85 = false;
  } else {
    result_85 = true;
  }
  return result_85;
}

function eQdestroy_1_I7a20g9_parq39nt2(s_46) {
  if ((!(mem.u32((s_46 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_57 = allocFixed(4);
      mem.setI32(i_57, 0);
      {
        while ((mem.i32(i_57) < mem.i32(s_46))) {
          inc_1_I6wjjge_cmdqs323n1(i_57);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_46 + 4)));
  }
}

function eQdestroyQ_SX50arser0parq39nt2_0_parq39nt2(dest_0) {
  nimStrDestroy((dest_0 + 8));
  eQdestroy_1_Ie8xo6a1_lex3r1urc1(dest_0);
}

function eQwasmovedQ_SX50arser0parq39nt2_0_parq39nt2(dest_0) {
  eQwasMoved_1_I4bu01z_lex3r1urc1(dest_0);
  nimStrWasMoved((dest_0 + 8));
}

let X60QiniGuard_0_parq39nt2 = allocFixed(1);

function X60Qini_0_parq39nt2() {
  if (mem.u8At(X60QiniGuard_0_parq39nt2)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_parq39nt2, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_tok9e79hf();
  X60Qini_0_nifjp9lau1();
  X60Qini_0_vfsc9jn7();
}
// generated by lengc (js backend) from osezuyu63.c.nif

let X60QiniGuard_0_osezuyu63 = allocFixed(1);

function X60Qini_0_osezuyu63() {
  if (mem.u8At(X60QiniGuard_0_osezuyu63)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_osezuyu63, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_err0o7h081();
}
// generated by lengc (js backend) from str7j0ifg.c.nif

let X60QiniGuard_0_str7j0ifg = allocFixed(1);

function X60Qini_0_str7j0ifg() {
  if (mem.u8At(X60QiniGuard_0_str7j0ifg)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_str7j0ifg, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_assy765wm();
  X60Qini_0_party5a2l1();
}
// generated by lengc (js backend) from envto7w6l1.c.nif

let environment_0_envto7w6l1 = allocFixed(8);

function dec_1_I0nzoz91_envto7w6l1(x_8) {
  mem.setI32(x_8, ((mem.i32(x_8) - 1) | 0));
}

let X60QiniGuard_0_envto7w6l1 = allocFixed(1);

function X60Qini_0_envto7w6l1() {
  if (mem.u8At(X60QiniGuard_0_envto7w6l1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_envto7w6l1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_str7j0ifg();
  X60Qini_0_osezuyu63();
  eQwasMoved_1_I5vdnla_cmdqs323n1(environment_0_envto7w6l1);
}
// generated by lengc (js backend) from assy765wm.c.nif

let X60QiniGuard_0_assy765wm = allocFixed(1);

function X60Qini_0_assy765wm() {
  if (mem.u8At(X60QiniGuard_0_assy765wm)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_assy765wm, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_syn1lfpjv();
}
// generated by lengc (js backend) from patta6rli.c.nif

let X60QiniGuard_0_patta6rli = allocFixed(1);

function X60Qini_0_patta6rli() {
  if (mem.u8At(X60QiniGuard_0_patta6rli)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_patta6rli, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_ossk30t39();
}
// generated by lengc (js backend) from memlzdyby.c.nif

let X60QiniGuard_0_memlzdyby = allocFixed(1);

function X60Qini_0_memlzdyby() {
  if (mem.u8At(X60QiniGuard_0_memlzdyby)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_memlzdyby, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_assy765wm();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_osezuyu63();
  X60Qini_0_pososrh1q1();
}
// generated by lengc (js backend) from tok9e79hf.c.nif

function isKeyword_0_tok9e79hf(s_0) {
  forStmtLabel_0: {
    var result_1;
    {
      whileStmtLabel_1: {
        var X60Qlf_0 = allocFixed(8);
        mem.copy(X60Qlf_0, toOpenArray_0_I9u1nsp_tok9e79hf(Keywords_0_tok9e79hf), 8);
        var X60Qlf_1 = allocFixed(4);
        mem.setI32(X60Qlf_1, 0);
        {
          while (true) {
            var X60Qx_2 = len_6_Igv2wyu1_osalirkw71(X60Qlf_0);
            if ((mem.i32(X60Qlf_1) < X60Qx_2)) {
              {
                var X60Qii_2 = getQ_10_Ik9hgkq1_osalirkw71(X60Qlf_0, mem.i32(X60Qlf_1));
                var X60Qx_3 = eqQ_20_sysvq0asl(X60Qii_2, s_0);
                if (X60Qx_3) {
                  return true;
                }
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_1);
            } else {
              break;
            }
          }
        }
      }
    }
  }
  return false;
  return result_1;
}

function initToken_0_tok9e79hf(kind_0, line_0, col_0) {
  let result_2 = allocFixed(72);
  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(result_2);
  eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(result_2);
  let X60Qx_4 = allocFixed(8);
  mem.copy(X60Qx_4, newSeqUninit_0_Im3cqd9_cmdqs323n1(0), 8);
  mem.copy(result_2, (() => {
    let _o = allocFixed(72);
    mem.setU8(_o, kind_0);
    mem.copy((_o + 4), (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    mem.setI64((_o + 16), 0n);
    mem.setF64((_o + 24), 0.0);
    mem.copy((_o + 32), (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    mem.setI32((_o + 40), line_0);
    mem.setI32((_o + 44), col_0);
    mem.setI32((_o + 48), col_0);
    mem.setI32((_o + 52), -1);
    mem.setU8((_o + 56), false);
    mem.copy((_o + 60), X60Qx_4, 8);
    return _o;
  })(), 72);
  return result_2;
}

function toOpenArray_0_I9u1nsp_tok9e79hf(x_1) {
  let result_3 = allocFixed(8);
  let X60Qx_0 = allocFixed(8);
  if (((((65 | 0) + 1) | 0) === 0)) {
    mem.copy(X60Qx_0, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    mem.copy(X60Qx_0, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, x_1);
      mem.setI32((_o + 4), (((65 | 0) + 1) | 0));
      return _o;
    })(), 8);
  }
  mem.copy(result_3, X60Qx_0, 8);
  return result_3;
}

function eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(dest_0) {
  eQdestroy_1_Ivioh0a_cmdqs323n1((dest_0 + 60));
  nimStrDestroy((dest_0 + 32));
  nimStrDestroy((dest_0 + 4));
}

function eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(dest_0) {
  nimStrWasMoved((dest_0 + 4));
  nimStrWasMoved((dest_0 + 32));
  eQwasMoved_1_I5vdnla_cmdqs323n1((dest_0 + 60));
}

function eQdupQ_SX54oken0tok9e79hf_0_tok9e79hf(src_0) {
  let dest_0 = allocFixed(72);
  mem.setU8(dest_0, mem.u8At(src_0));
  let X60Qx_15 = allocFixed(8);
  mem.copy(X60Qx_15, nimStrDup((src_0 + 4)), 8);
  mem.copy((dest_0 + 4), X60Qx_15, 8);
  mem.setI64((dest_0 + 16), mem.i64b((src_0 + 16)));
  mem.setF64((dest_0 + 24), mem.f64((src_0 + 24)));
  let X60Qx_16 = allocFixed(8);
  mem.copy(X60Qx_16, nimStrDup((src_0 + 32)), 8);
  mem.copy((dest_0 + 32), X60Qx_16, 8);
  mem.setI32((dest_0 + 40), mem.i32((src_0 + 40)));
  mem.setI32((dest_0 + 44), mem.i32((src_0 + 44)));
  mem.setI32((dest_0 + 48), mem.i32((src_0 + 48)));
  mem.setI32((dest_0 + 52), mem.i32((src_0 + 52)));
  mem.setU8((dest_0 + 56), mem.u8At((src_0 + 56)));
  let X60Qx_17 = allocFixed(8);
  mem.copy(X60Qx_17, eQdup_1_Imq0s4c_cmdqs323n1((src_0 + 60)), 8);
  mem.copy((dest_0 + 60), X60Qx_17, 8);
  return dest_0;
}

let X60QiniGuard_0_tok9e79hf = allocFixed(1);

function X60Qini_0_tok9e79hf() {
  if (mem.u8At(X60QiniGuard_0_tok9e79hf)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_tok9e79hf, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from pososrh1q1.c.nif

let X60QiniGuard_0_pososrh1q1 = allocFixed(1);

function X60Qini_0_pososrh1q1() {
  if (mem.u8At(X60QiniGuard_0_pososrh1q1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_pososrh1q1, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from oswd7dmm.c.nif

let X60QiniGuard_0_oswd7dmm = allocFixed(1);

function X60Qini_0_oswd7dmm() {
  if (mem.u8At(X60QiniGuard_0_oswd7dmm)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_oswd7dmm, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_str7j0ifg();
  X60Qini_0_pososrh1q1();
  X60Qini_0_cmdqs323n1();
  X60Qini_0_envto7w6l1();
  X60Qini_0_osezuyu63();
  X60Qini_0_ospaexnw61();
  X60Qini_0_ossk30t39();
  X60Qini_0_osalirkw71();
  X60Qini_0_osc4bsu0d1();
}
// generated by lengc (js backend) from for2ybv4p1.c.nif

let X60QiniGuard_0_for2ybv4p1 = allocFixed(1);

function X60Qini_0_for2ybv4p1() {
  if (mem.u8At(X60QiniGuard_0_for2ybv4p1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_for2ybv4p1, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from websvfj9k1.c.nif

function diag_0_websvfj9k1(line_0, col_0, msg_0) {
  let result_0 = allocFixed(16);
  eQwasmovedQ_SX44iag0websvfj9k1_0_websvfj9k1(result_0);
  eQdestroyQ_SX44iag0websvfj9k1_0_websvfj9k1(result_0);
  let X60Qx_6 = allocFixed(8);
  mem.copy(X60Qx_6, nimStrDup(msg_0), 8);
  mem.copy(result_0, (() => {
    let _o = allocFixed(16);
    mem.setI32(_o, line_0);
    mem.setI32((_o + 4), col_0);
    mem.copy((_o + 8), X60Qx_6, 8);
    return _o;
  })(), 16);
  return result_0;
}

function scur_0_websvfj9k1(s_0) {
  let result_1;
  let X60Qx_0;
  if ((mem.i32((s_0 + 12)) < mem.i32((s_0 + 8)))) {
    let X60Qx_7 = getQ_9_sysvq0asl(s_0, mem.i32((s_0 + 12)));
    X60Qx_0 = X60Qx_7;
  } else {
    X60Qx_0 = 0;
  }
  result_1 = X60Qx_0;
  return result_1;
}

function speek_0_websvfj9k1(s_1, k_0) {
  let result_2;
  let p_0 = ((mem.i32((s_1 + 12)) + k_0) | 0);
  let X60Qx_1;
  if ((p_0 < mem.i32((s_1 + 8)))) {
    let X60Qx_8 = getQ_9_sysvq0asl(s_1, p_0);
    X60Qx_1 = X60Qx_8;
  } else {
    X60Qx_1 = 0;
  }
  result_2 = X60Qx_1;
  return result_2;
}

function sadv_0_websvfj9k1(s_2) {
  if ((mem.i32((s_2 + 12)) < mem.i32((s_2 + 8)))) {
    let X60Qx_9 = getQ_9_sysvq0asl(s_2, mem.i32((s_2 + 12)));
    if ((X60Qx_9 === 10)) {
      inc_1_I6wjjge_cmdqs323n1((s_2 + 16));
      mem.setI32((s_2 + 20), 0);
    } else {
      inc_1_I6wjjge_cmdqs323n1((s_2 + 20));
    }
    inc_1_I6wjjge_cmdqs323n1((s_2 + 12));
  }
}

function isDigitC_0_websvfj9k1(c_0) {
  let result_3;
  let X60Qx_10;
  if ((48 <= c_0)) {
    X60Qx_10 = (c_0 <= 57);
  } else {
    X60Qx_10 = false;
  }
  result_3 = X60Qx_10;
  return result_3;
}

function isHexC_0_websvfj9k1(c_1) {
  let result_4;
  let X60Qx_11;
  let X60Qx_12;
  let X60Qx_13 = isDigitC_0_websvfj9k1(c_1);
  if (X60Qx_13) {
    X60Qx_12 = true;
  } else {
    let X60Qx_14;
    if ((97 <= c_1)) {
      X60Qx_14 = (c_1 <= 102);
    } else {
      X60Qx_14 = false;
    }
    X60Qx_12 = X60Qx_14;
  }
  if (X60Qx_12) {
    X60Qx_11 = true;
  } else {
    let X60Qx_15;
    if ((65 <= c_1)) {
      X60Qx_15 = (c_1 <= 70);
    } else {
      X60Qx_15 = false;
    }
    X60Qx_11 = X60Qx_15;
  }
  result_4 = X60Qx_11;
  return result_4;
}

function isIdentStartC_0_websvfj9k1(c_2) {
  let result_5;
  let X60Qx_16;
  let X60Qx_17;
  if ((c_2 === 95)) {
    X60Qx_17 = true;
  } else {
    let X60Qx_18;
    if ((97 <= c_2)) {
      X60Qx_18 = (c_2 <= 122);
    } else {
      X60Qx_18 = false;
    }
    X60Qx_17 = X60Qx_18;
  }
  if (X60Qx_17) {
    X60Qx_16 = true;
  } else {
    let X60Qx_19;
    if ((65 <= c_2)) {
      X60Qx_19 = (c_2 <= 90);
    } else {
      X60Qx_19 = false;
    }
    X60Qx_16 = X60Qx_19;
  }
  result_5 = X60Qx_16;
  return result_5;
}

function isIdentContC_0_websvfj9k1(c_3) {
  let result_6;
  let X60Qx_20;
  let X60Qx_21 = isIdentStartC_0_websvfj9k1(c_3);
  if (X60Qx_21) {
    X60Qx_20 = true;
  } else {
    let X60Qx_22 = isDigitC_0_websvfj9k1(c_3);
    X60Qx_20 = X60Qx_22;
  }
  result_6 = X60Qx_20;
  return result_6;
}

function skipEscape_0_websvfj9k1(s_3) {
  sadv_0_websvfj9k1(s_3);
  var c_4 = scur_0_websvfj9k1(s_3);
  {
    var $csel0 = c_4;
    if ((($csel0 === 120) || ($csel0 === 88))) {
      whileStmtLabel_0: {
        sadv_0_websvfj9k1(s_3);
        var k_5 = allocFixed(4);
        mem.setI32(k_5, 0);
        {
          while (true) {
            var X60Qx_23;
            if ((mem.i32(k_5) < 2)) {
              var X60Qx_24 = scur_0_websvfj9k1(s_3);
              var X60Qx_25 = isHexC_0_websvfj9k1(X60Qx_24);
              X60Qx_23 = X60Qx_25;
            } else {
              X60Qx_23 = false;
            }
            if (X60Qx_23) {
              sadv_0_websvfj9k1(s_3);
              inc_1_I6wjjge_cmdqs323n1(k_5);
            } else {
              break;
            }
          }
        }
      }
    } else if ((($csel0 === 117) || ($csel0 === 85))) {
      sadv_0_websvfj9k1(s_3);
      var X60Qx_26 = scur_0_websvfj9k1(s_3);
      if ((X60Qx_26 === 123)) {
        whileStmtLabel_1: {
          sadv_0_websvfj9k1(s_3);
          {
            while (true) {
              var X60Qx_27;
              var X60Qx_28 = scur_0_websvfj9k1(s_3);
              if ((!(X60Qx_28 === 125))) {
                X60Qx_27 = (mem.i32((s_3 + 12)) < mem.i32((s_3 + 8)));
              } else {
                X60Qx_27 = false;
              }
              if (X60Qx_27) {
                sadv_0_websvfj9k1(s_3);
              } else {
                break;
              }
            }
          }
        }
        var X60Qx_29 = scur_0_websvfj9k1(s_3);
        if ((X60Qx_29 === 125)) {
          sadv_0_websvfj9k1(s_3);
        }
      } else {
        whileStmtLabel_2: {
          var k_6 = allocFixed(4);
          mem.setI32(k_6, 0);
          {
            while (true) {
              var X60Qx_30;
              if ((mem.i32(k_6) < 4)) {
                var X60Qx_31 = scur_0_websvfj9k1(s_3);
                var X60Qx_32 = isHexC_0_websvfj9k1(X60Qx_31);
                X60Qx_30 = X60Qx_32;
              } else {
                X60Qx_30 = false;
              }
              if (X60Qx_30) {
                sadv_0_websvfj9k1(s_3);
                inc_1_I6wjjge_cmdqs323n1(k_6);
              } else {
                break;
              }
            }
          }
        }
      }
    } else if ((($csel0 >= 48) && ($csel0 <= 57))) {
      whileStmtLabel_3: {
        {
          while (true) {
            var X60Qx_33 = scur_0_websvfj9k1(s_3);
            var X60Qx_34 = isDigitC_0_websvfj9k1(X60Qx_33);
            if (X60Qx_34) {
              sadv_0_websvfj9k1(s_3);
            } else {
              break;
            }
          }
        }
      }
    } else {
      if ((mem.i32((s_3 + 12)) < mem.i32((s_3 + 8)))) {
        sadv_0_websvfj9k1(s_3);
      }
    }
  }
}

function scanNumber_0_websvfj9k1(s_4) {
  whileStmtLabel_0: {
    {
      while ((mem.i32((s_4 + 12)) < mem.i32((s_4 + 8)))) {
        var ch_0 = scur_0_websvfj9k1(s_4);
        var X60Qx_35;
        var X60Qx_36;
        var X60Qx_37;
        var X60Qx_38;
        var X60Qx_39;
        var X60Qx_40 = isHexC_0_websvfj9k1(ch_0);
        if (X60Qx_40) {
          X60Qx_39 = true;
        } else {
          X60Qx_39 = (ch_0 === 95);
        }
        if (X60Qx_39) {
          X60Qx_38 = true;
        } else {
          X60Qx_38 = (ch_0 === 120);
        }
        if (X60Qx_38) {
          X60Qx_37 = true;
        } else {
          X60Qx_37 = (ch_0 === 88);
        }
        if (X60Qx_37) {
          X60Qx_36 = true;
        } else {
          X60Qx_36 = (ch_0 === 111);
        }
        if (X60Qx_36) {
          X60Qx_35 = true;
        } else {
          X60Qx_35 = (ch_0 === 79);
        }
        if (X60Qx_35) {
          sadv_0_websvfj9k1(s_4);
        } else {
          var X60Qx_41;
          if ((ch_0 === 46)) {
            var X60Qx_42 = speek_0_websvfj9k1(s_4, 1);
            var X60Qx_43 = isDigitC_0_websvfj9k1(X60Qx_42);
            X60Qx_41 = X60Qx_43;
          } else {
            X60Qx_41 = false;
          }
          if (X60Qx_41) {
            sadv_0_websvfj9k1(s_4);
          } else {
            break whileStmtLabel_0;
          }
        }
      }
    }
  }
  var X60Qx_44 = scur_0_websvfj9k1(s_4);
  if ((X60Qx_44 === 39)) {
    whileStmtLabel_1: {
      sadv_0_websvfj9k1(s_4);
      {
        while (true) {
          var X60Qx_45;
          if ((mem.i32((s_4 + 12)) < mem.i32((s_4 + 8)))) {
            var X60Qx_46 = scur_0_websvfj9k1(s_4);
            var X60Qx_47 = isIdentContC_0_websvfj9k1(X60Qx_46);
            X60Qx_45 = X60Qx_47;
          } else {
            X60Qx_45 = false;
          }
          if (X60Qx_45) {
            sadv_0_websvfj9k1(s_4);
          } else {
            break;
          }
        }
      }
    }
  }
}

function scanString_0_websvfj9k1(s_5, diags_0) {
  whileStmtLabel_0: {
    var ln_0 = mem.i32((s_5 + 16));
    var cl_0 = mem.i32((s_5 + 20));
    sadv_0_websvfj9k1(s_5);
    {
      while (true) {
        var X60Qx_48;
        var X60Qx_49;
        if ((mem.i32((s_5 + 12)) < mem.i32((s_5 + 8)))) {
          var X60Qx_50 = scur_0_websvfj9k1(s_5);
          X60Qx_49 = (!(X60Qx_50 === 34));
        } else {
          X60Qx_49 = false;
        }
        if (X60Qx_49) {
          var X60Qx_51 = scur_0_websvfj9k1(s_5);
          X60Qx_48 = (!(X60Qx_51 === 10));
        } else {
          X60Qx_48 = false;
        }
        if (X60Qx_48) {
          var X60Qx_52 = scur_0_websvfj9k1(s_5);
          if ((X60Qx_52 === 92)) {
            skipEscape_0_websvfj9k1(s_5);
          } else {
            sadv_0_websvfj9k1(s_5);
          }
        } else {
          break;
        }
      }
    }
  }
  var X60Qx_53 = scur_0_websvfj9k1(s_5);
  if ((X60Qx_53 === 34)) {
    sadv_0_websvfj9k1(s_5);
  } else {
    var X60Qx_54 = allocFixed(16);
    mem.copy(X60Qx_54, diag_0_websvfj9k1(ln_0, cl_0, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1953396222);
      mem.setU32((_o + 4), strlit_0_I8436252750452789659_websvfj9k1);
      return _o;
    })()), 16);
    add_0_Ihpko8v1_websvfj9k1(diags_0, X60Qx_54);
  }
}

function scanTriple_0_websvfj9k1(s_6, diags_1) {
  whileStmtLabel_0: {
    var ln_1 = mem.i32((s_6 + 16));
    var cl_1 = mem.i32((s_6 + 20));
    sadv_0_websvfj9k1(s_6);
    sadv_0_websvfj9k1(s_6);
    sadv_0_websvfj9k1(s_6);
    var closed_0 = false;
    {
      while ((mem.i32((s_6 + 12)) < mem.i32((s_6 + 8)))) {
        var X60Qx_55;
        var X60Qx_56;
        var X60Qx_57;
        var X60Qx_58 = scur_0_websvfj9k1(s_6);
        if ((X60Qx_58 === 34)) {
          var X60Qx_59 = speek_0_websvfj9k1(s_6, 1);
          X60Qx_57 = (X60Qx_59 === 34);
        } else {
          X60Qx_57 = false;
        }
        if (X60Qx_57) {
          var X60Qx_60 = speek_0_websvfj9k1(s_6, 2);
          X60Qx_56 = (X60Qx_60 === 34);
        } else {
          X60Qx_56 = false;
        }
        if (X60Qx_56) {
          var X60Qx_61 = speek_0_websvfj9k1(s_6, 3);
          X60Qx_55 = (!(X60Qx_61 === 34));
        } else {
          X60Qx_55 = false;
        }
        if (X60Qx_55) {
          sadv_0_websvfj9k1(s_6);
          sadv_0_websvfj9k1(s_6);
          sadv_0_websvfj9k1(s_6);
          closed_0 = true;
          break whileStmtLabel_0;
        } else {
          sadv_0_websvfj9k1(s_6);
        }
      }
    }
  }
  if ((!closed_0)) {
    var X60Qx_62 = allocFixed(16);
    mem.copy(X60Qx_62, diag_0_websvfj9k1(ln_1, cl_1, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 1953396222);
      mem.setU32((_o + 4), strlit_0_I7436273935627428487_websvfj9k1);
      return _o;
    })()), 16);
    add_0_Ihpko8v1_websvfj9k1(diags_1, X60Qx_62);
  }
}

function scanRawOrTriple_0_websvfj9k1(s_7, diags_2) {
  var ln_2 = mem.i32((s_7 + 16));
  var cl_2 = mem.i32((s_7 + 20));
  sadv_0_websvfj9k1(s_7);
  var X60Qx_63;
  var X60Qx_64;
  var X60Qx_65 = scur_0_websvfj9k1(s_7);
  if ((X60Qx_65 === 34)) {
    var X60Qx_66 = speek_0_websvfj9k1(s_7, 1);
    X60Qx_64 = (X60Qx_66 === 34);
  } else {
    X60Qx_64 = false;
  }
  if (X60Qx_64) {
    var X60Qx_67 = speek_0_websvfj9k1(s_7, 2);
    X60Qx_63 = (X60Qx_67 === 34);
  } else {
    X60Qx_63 = false;
  }
  if (X60Qx_63) {
    whileStmtLabel_0: {
      sadv_0_websvfj9k1(s_7);
      sadv_0_websvfj9k1(s_7);
      sadv_0_websvfj9k1(s_7);
      var closed_1 = false;
      {
        while ((mem.i32((s_7 + 12)) < mem.i32((s_7 + 8)))) {
          var X60Qx_68;
          var X60Qx_69;
          var X60Qx_70;
          var X60Qx_71 = scur_0_websvfj9k1(s_7);
          if ((X60Qx_71 === 34)) {
            var X60Qx_72 = speek_0_websvfj9k1(s_7, 1);
            X60Qx_70 = (X60Qx_72 === 34);
          } else {
            X60Qx_70 = false;
          }
          if (X60Qx_70) {
            var X60Qx_73 = speek_0_websvfj9k1(s_7, 2);
            X60Qx_69 = (X60Qx_73 === 34);
          } else {
            X60Qx_69 = false;
          }
          if (X60Qx_69) {
            var X60Qx_74 = speek_0_websvfj9k1(s_7, 3);
            X60Qx_68 = (!(X60Qx_74 === 34));
          } else {
            X60Qx_68 = false;
          }
          if (X60Qx_68) {
            sadv_0_websvfj9k1(s_7);
            sadv_0_websvfj9k1(s_7);
            sadv_0_websvfj9k1(s_7);
            closed_1 = true;
            break whileStmtLabel_0;
          } else {
            sadv_0_websvfj9k1(s_7);
          }
        }
      }
    }
    if ((!closed_1)) {
      var X60Qx_75 = allocFixed(16);
      mem.copy(X60Qx_75, diag_0_websvfj9k1(ln_2, cl_2, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1953396222);
        mem.setU32((_o + 4), strlit_0_I14740933442681856299_websvfj9k1);
        return _o;
      })()), 16);
      add_0_Ihpko8v1_websvfj9k1(diags_2, X60Qx_75);
    }
  } else {
    whileStmtLabel_1: {
      sadv_0_websvfj9k1(s_7);
      var closed_2 = false;
      {
        while (true) {
          var X60Qx_76;
          if ((mem.i32((s_7 + 12)) < mem.i32((s_7 + 8)))) {
            var X60Qx_77 = scur_0_websvfj9k1(s_7);
            X60Qx_76 = (!(X60Qx_77 === 10));
          } else {
            X60Qx_76 = false;
          }
          if (X60Qx_76) {
            var X60Qx_78 = scur_0_websvfj9k1(s_7);
            if ((X60Qx_78 === 34)) {
              var X60Qx_79 = speek_0_websvfj9k1(s_7, 1);
              if ((X60Qx_79 === 34)) {
                sadv_0_websvfj9k1(s_7);
                sadv_0_websvfj9k1(s_7);
              } else {
                sadv_0_websvfj9k1(s_7);
                closed_2 = true;
                break whileStmtLabel_1;
              }
            } else {
              sadv_0_websvfj9k1(s_7);
            }
          } else {
            break;
          }
        }
      }
    }
    if ((!closed_2)) {
      var X60Qx_80 = allocFixed(16);
      mem.copy(X60Qx_80, diag_0_websvfj9k1(ln_2, cl_2, (() => {
        var _o = allocFixed(8);
        mem.setU32(_o, 1953396222);
        mem.setU32((_o + 4), strlit_0_I5838082098074422888_websvfj9k1);
        return _o;
      })()), 16);
      add_0_Ihpko8v1_websvfj9k1(diags_2, X60Qx_80);
    }
  }
}

function scanChar_0_websvfj9k1(s_8, diags_3) {
  let ln_3 = mem.i32((s_8 + 16));
  let cl_3 = mem.i32((s_8 + 20));
  sadv_0_websvfj9k1(s_8);
  let X60Qx_81 = scur_0_websvfj9k1(s_8);
  if ((X60Qx_81 === 92)) {
    skipEscape_0_websvfj9k1(s_8);
  } else {
    if ((mem.i32((s_8 + 12)) < mem.i32((s_8 + 8)))) {
      sadv_0_websvfj9k1(s_8);
    }
  }
  let X60Qx_82 = scur_0_websvfj9k1(s_8);
  if ((X60Qx_82 === 39)) {
    sadv_0_websvfj9k1(s_8);
  } else {
    let X60Qx_83 = allocFixed(16);
    mem.copy(X60Qx_83, diag_0_websvfj9k1(ln_3, cl_3, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1953396222);
      mem.setU32((_o + 4), strlit_0_I11780787593763197124_websvfj9k1);
      return _o;
    })()), 16);
    add_0_Ihpko8v1_websvfj9k1(diags_3, X60Qx_83);
  }
}

function lexDiags_0_websvfj9k1(src_0) {
  whileStmtLabel_0: {
    var result_7 = allocFixed(8);
    eQwasMoved_1_Ir71du1_websvfj9k1(result_7);
    eQdestroy_1_I6sickx1_websvfj9k1(result_7);
    var X60Qx_84 = allocFixed(8);
    mem.copy(X60Qx_84, newSeqUninit_0_I9wvfbd_websvfj9k1(0), 8);
    mem.copy(result_7, X60Qx_84, 8);
    var X60Qx_85 = allocFixed(8);
    mem.copy(X60Qx_85, nimStrDup(src_0), 8);
    var X60Qx_86 = len_4_sysvq0asl(src_0);
    var s_10 = allocFixed(24);
    mem.copy(s_10, X60Qx_85, 8);
    mem.setI32((s_10 + 8), X60Qx_86);
    mem.setI32((s_10 + 12), 0);
    mem.setI32((s_10 + 16), 1);
    mem.setI32((s_10 + 20), 0);
    {
      while ((mem.i32((s_10 + 12)) < mem.i32((s_10 + 8)))) {
        var c_5 = scur_0_websvfj9k1(s_10);
        if ((c_5 === 35)) {
          var X60Qx_87 = speek_0_websvfj9k1(s_10, 1);
          if ((X60Qx_87 === 91)) {
            whileStmtLabel_1: {
              var ln_4 = mem.i32((s_10 + 16));
              var cl_4 = mem.i32((s_10 + 20));
              sadv_0_websvfj9k1(s_10);
              sadv_0_websvfj9k1(s_10);
              var depth_0 = allocFixed(4);
              mem.setI32(depth_0, 1);
              {
                while (true) {
                  var X60Qx_88;
                  if ((mem.i32((s_10 + 12)) < mem.i32((s_10 + 8)))) {
                    X60Qx_88 = (0 < mem.i32(depth_0));
                  } else {
                    X60Qx_88 = false;
                  }
                  if (X60Qx_88) {
                    var X60Qx_89;
                    var X60Qx_90 = scur_0_websvfj9k1(s_10);
                    if ((X60Qx_90 === 35)) {
                      var X60Qx_91 = speek_0_websvfj9k1(s_10, 1);
                      X60Qx_89 = (X60Qx_91 === 91);
                    } else {
                      X60Qx_89 = false;
                    }
                    if (X60Qx_89) {
                      sadv_0_websvfj9k1(s_10);
                      sadv_0_websvfj9k1(s_10);
                      inc_1_I6wjjge_cmdqs323n1(depth_0);
                    } else {
                      var X60Qx_92;
                      var X60Qx_93 = scur_0_websvfj9k1(s_10);
                      if ((X60Qx_93 === 93)) {
                        var X60Qx_94 = speek_0_websvfj9k1(s_10, 1);
                        X60Qx_92 = (X60Qx_94 === 35);
                      } else {
                        X60Qx_92 = false;
                      }
                      if (X60Qx_92) {
                        sadv_0_websvfj9k1(s_10);
                        sadv_0_websvfj9k1(s_10);
                        dec_1_I0nzoz91_envto7w6l1(depth_0);
                      } else {
                        sadv_0_websvfj9k1(s_10);
                      }
                    }
                  } else {
                    break;
                  }
                }
              }
            }
            if ((0 < mem.i32(depth_0))) {
              var X60Qx_95 = allocFixed(16);
              mem.copy(X60Qx_95, diag_0_websvfj9k1(ln_4, cl_4, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1668183550);
                mem.setU32((_o + 4), strlit_0_I12890960710833486046_websvfj9k1);
                return _o;
              })()), 16);
              add_0_Ihpko8v1_websvfj9k1(result_7, X60Qx_95);
            }
          } else {
            var X60Qx_96;
            var X60Qx_97 = speek_0_websvfj9k1(s_10, 1);
            if ((X60Qx_97 === 35)) {
              var X60Qx_98 = speek_0_websvfj9k1(s_10, 2);
              X60Qx_96 = (X60Qx_98 === 91);
            } else {
              X60Qx_96 = false;
            }
            if (X60Qx_96) {
              whileStmtLabel_2: {
                var ln_5 = mem.i32((s_10 + 16));
                var cl_5 = mem.i32((s_10 + 20));
                sadv_0_websvfj9k1(s_10);
                sadv_0_websvfj9k1(s_10);
                sadv_0_websvfj9k1(s_10);
                var depth_1 = allocFixed(4);
                mem.setI32(depth_1, 1);
                {
                  while (true) {
                    var X60Qx_99;
                    if ((mem.i32((s_10 + 12)) < mem.i32((s_10 + 8)))) {
                      X60Qx_99 = (0 < mem.i32(depth_1));
                    } else {
                      X60Qx_99 = false;
                    }
                    if (X60Qx_99) {
                      var X60Qx_100;
                      var X60Qx_101;
                      var X60Qx_102 = scur_0_websvfj9k1(s_10);
                      if ((X60Qx_102 === 35)) {
                        var X60Qx_103 = speek_0_websvfj9k1(s_10, 1);
                        X60Qx_101 = (X60Qx_103 === 35);
                      } else {
                        X60Qx_101 = false;
                      }
                      if (X60Qx_101) {
                        var X60Qx_104 = speek_0_websvfj9k1(s_10, 2);
                        X60Qx_100 = (X60Qx_104 === 91);
                      } else {
                        X60Qx_100 = false;
                      }
                      if (X60Qx_100) {
                        sadv_0_websvfj9k1(s_10);
                        sadv_0_websvfj9k1(s_10);
                        sadv_0_websvfj9k1(s_10);
                        inc_1_I6wjjge_cmdqs323n1(depth_1);
                      } else {
                        var X60Qx_105;
                        var X60Qx_106;
                        var X60Qx_107 = scur_0_websvfj9k1(s_10);
                        if ((X60Qx_107 === 93)) {
                          var X60Qx_108 = speek_0_websvfj9k1(s_10, 1);
                          X60Qx_106 = (X60Qx_108 === 35);
                        } else {
                          X60Qx_106 = false;
                        }
                        if (X60Qx_106) {
                          var X60Qx_109 = speek_0_websvfj9k1(s_10, 2);
                          X60Qx_105 = (X60Qx_109 === 35);
                        } else {
                          X60Qx_105 = false;
                        }
                        if (X60Qx_105) {
                          sadv_0_websvfj9k1(s_10);
                          sadv_0_websvfj9k1(s_10);
                          sadv_0_websvfj9k1(s_10);
                          dec_1_I0nzoz91_envto7w6l1(depth_1);
                        } else {
                          sadv_0_websvfj9k1(s_10);
                        }
                      }
                    } else {
                      break;
                    }
                  }
                }
              }
              if ((0 < mem.i32(depth_1))) {
                var X60Qx_110 = allocFixed(16);
                mem.copy(X60Qx_110, diag_0_websvfj9k1(ln_5, cl_5, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 1668183550);
                  mem.setU32((_o + 4), strlit_0_I15867609858545661460_websvfj9k1);
                  return _o;
                })()), 16);
                add_0_Ihpko8v1_websvfj9k1(result_7, X60Qx_110);
              }
            } else {
              whileStmtLabel_3: {
                {
                  while (true) {
                    var X60Qx_111;
                    if ((mem.i32((s_10 + 12)) < mem.i32((s_10 + 8)))) {
                      var X60Qx_112 = scur_0_websvfj9k1(s_10);
                      X60Qx_111 = (!(X60Qx_112 === 10));
                    } else {
                      X60Qx_111 = false;
                    }
                    if (X60Qx_111) {
                      sadv_0_websvfj9k1(s_10);
                    } else {
                      break;
                    }
                  }
                }
              }
            }
          }
        } else {
          if ((c_5 === 34)) {
            var X60Qx_113;
            var X60Qx_114 = speek_0_websvfj9k1(s_10, 1);
            if ((X60Qx_114 === 34)) {
              var X60Qx_115 = speek_0_websvfj9k1(s_10, 2);
              X60Qx_113 = (X60Qx_115 === 34);
            } else {
              X60Qx_113 = false;
            }
            if (X60Qx_113) {
              scanTriple_0_websvfj9k1(s_10, result_7);
            } else {
              scanString_0_websvfj9k1(s_10, result_7);
            }
          } else {
            var X60Qx_116;
            var X60Qx_117;
            if ((c_5 === 114)) {
              X60Qx_117 = true;
            } else {
              X60Qx_117 = (c_5 === 82);
            }
            if (X60Qx_117) {
              var X60Qx_118 = speek_0_websvfj9k1(s_10, 1);
              X60Qx_116 = (X60Qx_118 === 34);
            } else {
              X60Qx_116 = false;
            }
            if (X60Qx_116) {
              scanRawOrTriple_0_websvfj9k1(s_10, result_7);
            } else {
              if ((c_5 === 39)) {
                scanChar_0_websvfj9k1(s_10, result_7);
              } else {
                if ((c_5 === 96)) {
                  whileStmtLabel_4: {
                    sadv_0_websvfj9k1(s_10);
                    {
                      while (true) {
                        var X60Qx_119;
                        var X60Qx_120;
                        if ((mem.i32((s_10 + 12)) < mem.i32((s_10 + 8)))) {
                          var X60Qx_121 = scur_0_websvfj9k1(s_10);
                          X60Qx_120 = (!(X60Qx_121 === 96));
                        } else {
                          X60Qx_120 = false;
                        }
                        if (X60Qx_120) {
                          var X60Qx_122 = scur_0_websvfj9k1(s_10);
                          X60Qx_119 = (!(X60Qx_122 === 10));
                        } else {
                          X60Qx_119 = false;
                        }
                        if (X60Qx_119) {
                          sadv_0_websvfj9k1(s_10);
                        } else {
                          break;
                        }
                      }
                    }
                  }
                  var X60Qx_123 = scur_0_websvfj9k1(s_10);
                  if ((X60Qx_123 === 96)) {
                    sadv_0_websvfj9k1(s_10);
                  }
                } else {
                  var X60Qx_124 = isDigitC_0_websvfj9k1(c_5);
                  if (X60Qx_124) {
                    scanNumber_0_websvfj9k1(s_10);
                  } else {
                    var X60Qx_125 = isIdentStartC_0_websvfj9k1(c_5);
                    if (X60Qx_125) {
                      whileStmtLabel_5: {
                        {
                          while (true) {
                            var X60Qx_126;
                            if ((mem.i32((s_10 + 12)) < mem.i32((s_10 + 8)))) {
                              var X60Qx_127 = scur_0_websvfj9k1(s_10);
                              var X60Qx_128 = isIdentContC_0_websvfj9k1(X60Qx_127);
                              X60Qx_126 = X60Qx_128;
                            } else {
                              X60Qx_126 = false;
                            }
                            if (X60Qx_126) {
                              sadv_0_websvfj9k1(s_10);
                            } else {
                              break;
                            }
                          }
                        }
                      }
                    } else {
                      sadv_0_websvfj9k1(s_10);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  eQdestroyQ_SX53can0websvfj9k1_0_websvfj9k1(s_10);
  return result_7;
  eQdestroyQ_SX53can0websvfj9k1_0_websvfj9k1(s_10);
  return result_7;
}

function tokenizeD_0_websvfj9k1(src_1) {
  let result_8 = allocFixed(16);
  eQwasmovedQ_AtupleSseq0X49yai4gnSR60X49p6shd31_0_websvfj9k1(result_8);
  eQdestroyQ_AtupleSseq0X49yai4gnSR60X49p6shd31_0_websvfj9k1(result_8);
  let X60Qx_129 = allocFixed(8);
  mem.copy(X60Qx_129, tokenize_0_lex3r1urc1(src_1), 8);
  let X60Qx_130 = allocFixed(8);
  mem.copy(X60Qx_130, lexDiags_0_websvfj9k1(src_1), 8);
  mem.copy(result_8, (() => {
    let _o = allocFixed(16);
    mem.copy(_o, X60Qx_129, 8);
    mem.copy((_o + 8), X60Qx_130, 8);
    return _o;
  })(), 16);
  return result_8;
}

function isOpenBracket_0_websvfj9k1(k_1) {
  let result_9;
  let X60Qx_131;
  let X60Qx_132;
  if ((k_1 === 10)) {
    X60Qx_132 = true;
  } else {
    X60Qx_132 = (k_1 === 12);
  }
  if (X60Qx_132) {
    X60Qx_131 = true;
  } else {
    X60Qx_131 = (k_1 === 14);
  }
  result_9 = X60Qx_131;
  return result_9;
}

function isCloseBracket_0_websvfj9k1(k_2) {
  let result_10;
  let X60Qx_133;
  let X60Qx_134;
  if ((k_2 === 11)) {
    X60Qx_134 = true;
  } else {
    X60Qx_134 = (k_2 === 13);
  }
  if (X60Qx_134) {
    X60Qx_133 = true;
  } else {
    X60Qx_133 = (k_2 === 15);
  }
  result_10 = X60Qx_133;
  return result_10;
}

function closerFor_0_websvfj9k1(k_3) {
  let result_11;
  let X60Qx_2;
  switch (k_3) {
    case 10:
      {
        X60Qx_2 = 11;
      }
      break;
    case 12:
      {
        X60Qx_2 = 13;
      }
      break;
    case 14:
      {
        X60Qx_2 = 15;
      }
      break;
    default:
      {
        X60Qx_2 = 0;
      }
      break;
  }
  result_11 = X60Qx_2;
  return result_11;
}

function bracketName_0_websvfj9k1(k_4) {
  let result_12 = allocFixed(8);
  nimStrWasMoved(result_12);
  let X60Qx_3 = allocFixed(8);
  nimStrWasMoved(X60Qx_3);
  switch (k_4) {
    case 10:
    case 11:
      {
        nimStrDestroy(X60Qx_3);
        mem.copy(X60Qx_3, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 690497534);
          mem.setU32((_o + 4), strlit_0_I17451209550239811446_websvfj9k1);
          return _o;
        })(), 8);
      }
      break;
    case 12:
    case 13:
      {
        nimStrDestroy(X60Qx_3);
        mem.copy(X60Qx_3, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 1566255102);
          mem.setU32((_o + 4), strlit_0_I621061182478469467_websvfj9k1);
          return _o;
        })(), 8);
      }
      break;
    case 14:
    case 15:
      {
        nimStrDestroy(X60Qx_3);
        mem.copy(X60Qx_3, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 2105223166);
          mem.setU32((_o + 4), strlit_0_I15160080286962768302_websvfj9k1);
          return _o;
        })(), 8);
      }
      break;
    default:
      {
        nimStrDestroy(X60Qx_3);
        mem.copy(X60Qx_3, (() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 2565890);
          mem.setU32((_o + 4), 0);
          return _o;
        })(), 8);
      }
      break;
  }
  nimStrDestroy(result_12);
  mem.copy(result_12, X60Qx_3, 8);
  nimStrWasMoved(X60Qx_3);
  nimStrDestroy(X60Qx_3);
  return result_12;
  nimStrDestroy(X60Qx_3);
  return result_12;
}

function bracketDiags_0_websvfj9k1(toks_0) {
  forStmtLabel_4: {
    forStmtLabel_0: {
      var result_13 = allocFixed(8);
      eQwasMoved_1_Ir71du1_websvfj9k1(result_13);
      eQdestroy_1_I6sickx1_websvfj9k1(result_13);
      var X60Qx_135 = allocFixed(8);
      mem.copy(X60Qx_135, newSeqUninit_0_I9wvfbd_websvfj9k1(0), 8);
      mem.copy(result_13, X60Qx_135, 8);
      var stack_0 = allocFixed(8);
      mem.copy(stack_0, newSeqUninit_0_I28kyaw1_lex3r1urc1(0), 8);
      {
        whileStmtLabel_1: {
          var X60Qlf_0 = 0;
          var X60Qlf_1 = len_3_Iefkljt1_lex3r1urc1(toks_0);
          var X60Qlf_2 = allocFixed(4);
          mem.setI32(X60Qlf_2, X60Qlf_0);
          {
            while ((mem.i32(X60Qlf_2) < X60Qlf_1)) {
              {
                var X60Qx_136 = getQ_7_Ijq9cyk1_lex3r1urc1(toks_0, mem.i32(X60Qlf_2));
                var X60QconstRefTemp_0 = allocFixed(72);
                mem.copy(X60QconstRefTemp_0, X60Qx_136, 72);
                var X60Qii_2 = allocFixed(72);
                mem.copy(X60Qii_2, eQdupQ_SX54oken0tok9e79hf_0_tok9e79hf(X60QconstRefTemp_0), 72);
                var X60Qx_137 = isOpenBracket_0_websvfj9k1(mem.u8At(X60Qii_2));
                if (X60Qx_137) {
                  var X60Qtmp_0 = allocFixed(72);
                  mem.copy(X60Qtmp_0, X60Qii_2, 72);
                  eQwasmovedQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_2);
                  add_0_Icvfjtn_lex3r1urc1(stack_0, X60Qtmp_0);
                } else {
                  var X60Qx_138 = isCloseBracket_0_websvfj9k1(mem.u8At(X60Qii_2));
                  if (X60Qx_138) {
                    var X60Qx_139 = len_3_Iefkljt1_lex3r1urc1(stack_0);
                    if ((X60Qx_139 === 0)) {
                      var X60Qtmp_2 = allocFixed(8);
                      mem.copy(X60Qtmp_2, bracketName_0_websvfj9k1(mem.u8At(X60Qii_2)), 8);
                      var X60Qtmp_1 = allocFixed(8);
                      mem.copy(X60Qtmp_1, ampQ_0_sysvq0asl((() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 1835955710);
                        mem.setU32((_o + 4), strlit_0_I16111832319537461242_websvfj9k1);
                        return _o;
                      })(), X60Qtmp_2), 8);
                      var X60Qx_140 = allocFixed(16);
                      mem.copy(X60Qx_140, diag_0_websvfj9k1(mem.i32((X60Qii_2 + 40)), mem.i32((X60Qii_2 + 44)), X60Qtmp_1), 16);
                      add_0_Ihpko8v1_websvfj9k1(result_13, X60Qx_140);
                      nimStrDestroy(X60Qtmp_1);
                      nimStrDestroy(X60Qtmp_2);
                    } else {
                      var X60Qx_141 = len_3_Iefkljt1_lex3r1urc1(stack_0);
                      var X60Qx_142 = getQ_7_Ijq9cyk1_lex3r1urc1(stack_0, ((X60Qx_141 - 1) | 0));
                      var X60QconstRefTemp_1 = allocFixed(72);
                      mem.copy(X60QconstRefTemp_1, X60Qx_142, 72);
                      var X60Qii_3 = allocFixed(72);
                      mem.copy(X60Qii_3, eQdupQ_SX54oken0tok9e79hf_0_tok9e79hf(X60QconstRefTemp_1), 72);
                      var X60Qx_143 = closerFor_0_websvfj9k1(mem.u8At(X60Qii_3));
                      if ((!(X60Qx_143 === mem.u8At(X60Qii_2)))) {
                        var X60Qdesugar_0 = allocFixed(8);
                        mem.copy(X60Qdesugar_0, bracketName_0_websvfj9k1(mem.u8At(X60Qii_3)), 8);
                        var X60Qdesugar_1 = allocFixed(8);
                        mem.copy(X60Qdesugar_1, dollarQ_2_sysvq0asl(mem.i32((X60Qii_3 + 40))), 8);
                        var X60Qdesugar_2 = allocFixed(8);
                        mem.copy(X60Qdesugar_2, dollarQ_2_sysvq0asl(((mem.i32((X60Qii_3 + 44)) + 1) | 0)), 8);
                        var X60Qdesugar_3 = allocFixed(8);
                        mem.copy(X60Qdesugar_3, bracketName_0_websvfj9k1(mem.u8At(X60Qii_2)), 8);
                        var X60Qx_144 = len_4_sysvq0asl((() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1936289278);
                          mem.setU32((_o + 4), strlit_0_I2791062431570189588_websvfj9k1);
                          return _o;
                        })());
                        var X60Qx_145 = len_4_sysvq0asl(X60Qdesugar_0);
                        var X60Qx_146 = len_4_sysvq0asl((() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1886331134);
                          mem.setU32((_o + 4), strlit_0_I5340874533979027814_websvfj9k1);
                          return _o;
                        })());
                        var X60Qx_147 = len_4_sysvq0asl(X60Qdesugar_1);
                        var X60Qx_148 = len_4_sysvq0asl((() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 14849);
                          mem.setU32((_o + 4), 0);
                          return _o;
                        })());
                        var X60Qx_149 = len_4_sysvq0asl(X60Qdesugar_2);
                        var X60Qx_150 = len_4_sysvq0asl((() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1818435838);
                          mem.setU32((_o + 4), strlit_0_I13544407097396288341_websvfj9k1);
                          return _o;
                        })());
                        var X60Qx_151 = len_4_sysvq0asl(X60Qdesugar_3);
                        var X60Qdesugar_4 = allocFixed(8);
                        mem.copy(X60Qdesugar_4, newStringOfCap_0_sysvq0asl(((((((((((((((X60Qx_144 + X60Qx_145) | 0) + X60Qx_146) | 0) + X60Qx_147) | 0) + X60Qx_148) | 0) + X60Qx_149) | 0) + X60Qx_150) | 0) + X60Qx_151) | 0)), 8);
                        add_2_sysvq0asl(X60Qdesugar_4, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1936289278);
                          mem.setU32((_o + 4), strlit_0_I2791062431570189588_websvfj9k1);
                          return _o;
                        })());
                        add_2_sysvq0asl(X60Qdesugar_4, X60Qdesugar_0);
                        add_2_sysvq0asl(X60Qdesugar_4, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1886331134);
                          mem.setU32((_o + 4), strlit_0_I5340874533979027814_websvfj9k1);
                          return _o;
                        })());
                        add_2_sysvq0asl(X60Qdesugar_4, X60Qdesugar_1);
                        add_2_sysvq0asl(X60Qdesugar_4, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 14849);
                          mem.setU32((_o + 4), 0);
                          return _o;
                        })());
                        add_2_sysvq0asl(X60Qdesugar_4, X60Qdesugar_2);
                        add_2_sysvq0asl(X60Qdesugar_4, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 1818435838);
                          mem.setU32((_o + 4), strlit_0_I13544407097396288341_websvfj9k1);
                          return _o;
                        })());
                        add_2_sysvq0asl(X60Qdesugar_4, X60Qdesugar_3);
                        var X60Qx_152 = allocFixed(16);
                        mem.copy(X60Qx_152, diag_0_websvfj9k1(mem.i32((X60Qii_2 + 40)), mem.i32((X60Qii_2 + 44)), X60Qdesugar_4), 16);
                        add_0_Ihpko8v1_websvfj9k1(result_13, X60Qx_152);
                        var X60Qtmp_3 = allocFixed(72);
                        mem.copy(X60Qtmp_3, pop_0_Isrkbjh1_websvfj9k1(stack_0), 72);
                        var X60Qx_153 = allocFixed(72);
                        mem.copy(X60Qx_153, X60Qtmp_3, 72);
                        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_3);
                        nimStrDestroy(X60Qdesugar_4);
                        nimStrDestroy(X60Qdesugar_3);
                        nimStrDestroy(X60Qdesugar_2);
                        nimStrDestroy(X60Qdesugar_1);
                        nimStrDestroy(X60Qdesugar_0);
                      } else {
                        var X60Qtmp_4 = allocFixed(72);
                        mem.copy(X60Qtmp_4, pop_0_Isrkbjh1_websvfj9k1(stack_0), 72);
                        var X60Qx_154 = allocFixed(72);
                        mem.copy(X60Qx_154, X60Qtmp_4, 72);
                        eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qtmp_4);
                      }
                      eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_3);
                    }
                  }
                }
                eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_2);
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_2);
            }
          }
        }
      }
    }
    {
      whileStmtLabel_5: {
        var X60Qlf_3 = 0;
        var X60Qlf_4 = len_3_Iefkljt1_lex3r1urc1(stack_0);
        var X60Qlf_5 = allocFixed(4);
        mem.setI32(X60Qlf_5, X60Qlf_3);
        {
          while ((mem.i32(X60Qlf_5) < X60Qlf_4)) {
            {
              var X60Qx_155 = getQ_7_Ijq9cyk1_lex3r1urc1(stack_0, mem.i32(X60Qlf_5));
              var X60QconstRefTemp_2 = allocFixed(72);
              mem.copy(X60QconstRefTemp_2, X60Qx_155, 72);
              var X60Qii_6 = allocFixed(72);
              mem.copy(X60Qii_6, eQdupQ_SX54oken0tok9e79hf_0_tok9e79hf(X60QconstRefTemp_2), 72);
              var X60Qtmp_6 = allocFixed(8);
              mem.copy(X60Qtmp_6, bracketName_0_websvfj9k1(mem.u8At(X60Qii_6)), 8);
              var X60Qtmp_5 = allocFixed(8);
              mem.copy(X60Qtmp_5, ampQ_0_sysvq0asl((() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1668183550);
                mem.setU32((_o + 4), strlit_0_I7528375458768032574_websvfj9k1);
                return _o;
              })(), X60Qtmp_6), 8);
              var X60Qx_156 = allocFixed(16);
              mem.copy(X60Qx_156, diag_0_websvfj9k1(mem.i32((X60Qii_6 + 40)), mem.i32((X60Qii_6 + 44)), X60Qtmp_5), 16);
              add_0_Ihpko8v1_websvfj9k1(result_13, X60Qx_156);
              nimStrDestroy(X60Qtmp_5);
              nimStrDestroy(X60Qtmp_6);
              eQdestroyQ_SX54oken0tok9e79hf_0_tok9e79hf(X60Qii_6);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_5);
          }
        }
      }
    }
  }
  eQdestroy_1_Ie8xo6a1_lex3r1urc1(stack_0);
  return result_13;
  eQdestroy_1_Ie8xo6a1_lex3r1urc1(stack_0);
  return result_13;
}

function add_0_Ihpko8v1_websvfj9k1(s_15, elem_2) {
  let L_0 = mem.i32(s_15);
  let X60Qx_157 = capInBytes_0_I17ixy1_websvfj9k1(s_15);
  if ((X60Qx_157 < ((Math.imul(L_0, 16) + 16) | 0))) {
    let X60Qx_158 = resize_0_Idxptvu1_websvfj9k1(s_15, 1);
    if ((!X60Qx_158)) {
      eQdestroyQ_SX44iag0websvfj9k1_0_websvfj9k1(elem_2);
      return;
    }
  }
  inc_1_I6wjjge_cmdqs323n1(s_15);
  mem.copy((mem.u32((s_15 + 4)) + (L_0 * 16)), elem_2, 16);
}

function newSeqUninit_0_I9wvfbd_websvfj9k1(size_2) {
  let result_14 = allocFixed(8);
  if ((size_2 === 0)) {
    mem.copy(result_14, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_2);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_0 = memSizeInBytes_0_Iezfufr1_websvfj9k1(size_2);
    let X60Qx_159 = alloc_1_sysvq0asl(memSize_0);
    mem.copy(result_14, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_2);
      mem.setU32((_o + 4), X60Qx_159);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_14 + 4)) === 0))) {
      let X60Qx_160 = allocFixed(8);
      mem.setU32(X60Qx_160, 1634036990);
      mem.setU32((X60Qx_160 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_14, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_0);
    }
  }
  return result_14;
}

function pop_0_Isrkbjh1_websvfj9k1(s_21) {
  if ((!(0 < mem.i32(s_21)))) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I17487054685970555778_websvfj9k1);
      return _o;
    })());
  }
  let result_18 = allocFixed(72);
  let L_2 = ((mem.i32(s_21) - 1) | 0);
  let X60Qx_166 = getQ_7_Ijq9cyk1_lex3r1urc1(s_21, L_2);
  mem.copy(result_18, X60Qx_166, 72);
  mem.setI32(s_21, L_2);
  return result_18;
}

function capInBytes_0_I17ixy1_websvfj9k1(s_22) {
  let result_19;
  let X60Qx_4;
  if ((!(mem.u32((s_22 + 4)) === 0))) {
    let X60Qx_167 = allocatedSize_0_sysvq0asl(mem.u32((s_22 + 4)));
    X60Qx_4 = X60Qx_167;
  } else {
    X60Qx_4 = 0;
  }
  result_19 = X60Qx_4;
  return result_19;
}

function resize_0_Idxptvu1_websvfj9k1(dest_2, addedElements_2) {
  let result_20;
  let X60Qx_168 = capInBytes_0_I17ixy1_websvfj9k1(dest_2);
  let oldCap_0 = Math.trunc((X60Qx_168 / 16));
  let newCap_0 = recalcCap_0_sysvq0asl(oldCap_0, addedElements_2);
  let memSize_2 = memSizeInBytes_0_Iezfufr1_websvfj9k1(newCap_0);
  let X60Qx_169 = realloc_1_sysvq0asl(mem.u32((dest_2 + 4)), memSize_2);
  mem.setU32((dest_2 + 4), X60Qx_169);
  if ((mem.u32((dest_2 + 4)) === 0)) {
    mem.setI32(dest_2, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_2);
    result_20 = false;
  } else {
    result_20 = true;
  }
  return result_20;
}

function memSizeInBytes_0_Iezfufr1_websvfj9k1(size_6) {
  let result_21;
  let X60QconstRefTemp_0 = allocFixed(4);
  mem.setI32(X60QconstRefTemp_0, Math.imul(size_6, 16));
  result_21 = mem.i32(X60QconstRefTemp_0);
  if (false) {
    result_21 = 2147483647;
  }
  return result_21;
}

function eQdestroy_1_I6sickx1_websvfj9k1(s_28) {
  if ((!(mem.u32((s_28 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_5 = allocFixed(4);
      mem.setI32(i_5, 0);
      {
        while ((mem.i32(i_5) < mem.i32(s_28))) {
          eQdestroyQ_SX44iag0websvfj9k1_0_websvfj9k1((mem.u32((s_28 + 4)) + (mem.i32(i_5) * 16)));
          inc_1_I6wjjge_cmdqs323n1(i_5);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_28 + 4)));
  }
}

function eQwasMoved_1_Ir71du1_websvfj9k1(s_29) {
  mem.setI32(s_29, 0);
  mem.setU32((s_29 + 4), 0);
}

function eQdestroyQ_SX44iag0websvfj9k1_0_websvfj9k1(dest_0) {
  nimStrDestroy((dest_0 + 8));
}

function eQwasmovedQ_SX44iag0websvfj9k1_0_websvfj9k1(dest_0) {
  nimStrWasMoved((dest_0 + 8));
}

function eQdupQ_SX44iag0websvfj9k1_0_websvfj9k1(src_0) {
  let dest_0 = allocFixed(16);
  mem.setI32(dest_0, mem.i32(src_0));
  mem.setI32((dest_0 + 4), mem.i32((src_0 + 4)));
  let X60Qx_185 = allocFixed(8);
  mem.copy(X60Qx_185, nimStrDup((src_0 + 8)), 8);
  mem.copy((dest_0 + 8), X60Qx_185, 8);
  return dest_0;
}

function eQdestroyQ_SX53can0websvfj9k1_0_websvfj9k1(dest_0) {
  nimStrDestroy(dest_0);
}

function eQwasmovedQ_AtupleSseq0X49yai4gnSR60X49p6shd31_0_websvfj9k1(dest_0) {
  eQwasMoved_1_I4bu01z_lex3r1urc1(dest_0);
  eQwasMoved_1_Ir71du1_websvfj9k1((dest_0 + 8));
}

function eQdestroyQ_AtupleSseq0X49yai4gnSR60X49p6shd31_0_websvfj9k1(dest_0) {
  eQdestroy_1_Ie8xo6a1_lex3r1urc1(dest_0);
  eQdestroy_1_I6sickx1_websvfj9k1((dest_0 + 8));
}

let X60QiniGuard_0_websvfj9k1 = allocFixed(1);

function X60Qini_0_websvfj9k1() {
  if (mem.u8At(X60QiniGuard_0_websvfj9k1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_websvfj9k1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_tok9e79hf();
  X60Qini_0_lex3r1urc1();
}
// generated by lengc (js backend) from osc4bsu0d1.c.nif

let X60QiniGuard_0_osc4bsu0d1 = allocFixed(1);

function X60Qini_0_osc4bsu0d1() {
  if (mem.u8At(X60QiniGuard_0_osc4bsu0d1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_osc4bsu0d1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_osezuyu63();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_assy765wm();
  X60Qini_0_wid623gv();
  X60Qini_0_pososrh1q1();
}
// generated by lengc (js backend) from fen2xhzfd.c.nif

let X60QiniGuard_0_fen2xhzfd = allocFixed(1);

function X60Qini_0_fen2xhzfd() {
  if (mem.u8At(X60QiniGuard_0_fen2xhzfd)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_fen2xhzfd, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from mat7cnfv21.c.nif

function plusQeQ_0_Iz7fdp7_mat7cnfv21(x_147, y_41) {
  mem.setI32(x_147, ((mem.i32(x_147) + y_41) | 0));
}

function eQdestroy_1_Iv9ij5i1_mat7cnfv21(s_4) {
  if ((!(mem.u32((s_4 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_9 = allocFixed(4);
      mem.setI32(i_9, 0);
      {
        while ((mem.i32(i_9) < mem.i32(s_4))) {
          inc_1_I6wjjge_cmdqs323n1(i_9);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_4 + 4)));
  }
}

function eQwasMoved_1_Ix88qzs1_mat7cnfv21(s_5) {
  mem.setI32(s_5, 0);
  mem.setU32((s_5 + 4), 0);
}

function newSeqUninit_0_Iggfvwp_mat7cnfv21(size_4) {
  let result_81 = allocFixed(8);
  if ((size_4 === 0)) {
    mem.copy(result_81, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_4);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_2 = memSizeInBytes_0_Inv7kg3_mat7cnfv21(size_4);
    let X60Qx_73 = alloc_1_sysvq0asl(memSize_2);
    mem.copy(result_81, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_4);
      mem.setU32((_o + 4), X60Qx_73);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_81 + 4)) === 0))) {
      let X60Qx_74 = allocFixed(8);
      mem.setU32(X60Qx_74, 1634036990);
      mem.setU32((X60Qx_74 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_81, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_2);
    }
  }
  return result_81;
}

function capInBytes_0_Iet286n_mat7cnfv21(s_10) {
  let result_82;
  let X60Qx_1;
  if ((!(mem.u32((s_10 + 4)) === 0))) {
    let X60Qx_75 = allocatedSize_0_sysvq0asl(mem.u32((s_10 + 4)));
    X60Qx_1 = X60Qx_75;
  } else {
    X60Qx_1 = 0;
  }
  result_82 = X60Qx_1;
  return result_82;
}

function memSizeInBytes_0_Inv7kg3_mat7cnfv21(size_5) {
  let result_83;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_5, 4);
  result_83 = X60QconstRefTemp_0;
  if (false) {
    result_83 = 2147483647;
  }
  return result_83;
}

let X60QiniGuard_0_mat7cnfv21 = allocFixed(1);

function X60Qini_0_mat7cnfv21() {
  if (mem.u8At(X60QiniGuard_0_mat7cnfv21)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_mat7cnfv21, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_assy765wm();
  X60Qini_0_fen2xhzfd();
}
// generated by lengc (js backend) from ospaexnw61.c.nif

function dec_0_Ig5i8xp_ospaexnw61(x_7, y_3) {
  mem.setI32(x_7, ((mem.i32(x_7) - y_3) | 0));
}

let X60QiniGuard_0_ospaexnw61 = allocFixed(1);

function X60Qini_0_ospaexnw61() {
  if (mem.u8At(X60QiniGuard_0_ospaexnw61)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_ospaexnw61, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_str7j0ifg();
  X60Qini_0_osezuyu63();
  X60Qini_0_osc4bsu0d1();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_assy765wm();
  X60Qini_0_wid623gv();
  X60Qini_0_patta6rli();
  X60Qini_0_ossk30t39();
  X60Qini_0_pososrh1q1();
}
// generated by lengc (js backend) from webzywwor1.c.nif

function jsonEscape_0_webzywwor1(s_0) {
  forStmtLabel_0: {
    var result_0 = allocFixed(8);
    nimStrWasMoved(result_0);
    nimStrDestroy(result_0);
    mem.copy(result_0, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_1: {
        var X60Qlf_0 = allocFixed(8);
        mem.copy(X60Qlf_0, toOpenArray_2_sysvq0asl(s_0), 8);
        var X60Qlf_1 = allocFixed(4);
        mem.setI32(X60Qlf_1, 0);
        {
          while (true) {
            var X60Qx_1 = len_6_Iroq7kd1_has9tn57v(X60Qlf_0);
            if ((mem.i32(X60Qlf_1) < X60Qx_1)) {
              {
                var X60Qii_2 = getQ_10_I5nt6we_has9tn57v(X60Qlf_0, mem.i32(X60Qlf_1));
                switch (mem.u8At(X60Qii_2)) {
                  case 34:
                    {
                      add_2_sysvq0asl(result_0, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 2251778);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                    }
                    break;
                  case 92:
                    {
                      add_2_sysvq0asl(result_0, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 6052866);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                    }
                    break;
                  case 8:
                    {
                      add_2_sysvq0asl(result_0, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 6446082);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                    }
                    break;
                  case 12:
                    {
                      add_2_sysvq0asl(result_0, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 6708226);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                    }
                    break;
                  case 10:
                    {
                      add_2_sysvq0asl(result_0, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 7232514);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                    }
                    break;
                  case 13:
                    {
                      add_2_sysvq0asl(result_0, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 7494658);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                    }
                    break;
                  case 9:
                    {
                      add_2_sysvq0asl(result_0, (() => {
                        var _o = allocFixed(8);
                        mem.setU32(_o, 7625730);
                        mem.setU32((_o + 4), 0);
                        return _o;
                      })());
                    }
                    break;
                  default:
                    {
                      if ((mem.u8At(X60Qii_2) < 32)) {
                        var hex_0 = allocFixed(8);
                        mem.setU32(hex_0, 842084606);
                        mem.setU32((hex_0 + 4), strlit_0_I6105018409752412263_webzywwor1);
                        add_2_sysvq0asl(result_0, (() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 812997886);
                          mem.setU32((_o + 4), strlit_0_I4645790987703279553_webzywwor1);
                          return _o;
                        })());
                        var X60Qx_2 = getQ_9_sysvq0asl((() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 842084606);
                          mem.setU32((_o + 4), strlit_0_I6105018409752412263_webzywwor1);
                          return _o;
                        })(), ((mem.u8At(X60Qii_2) >> 4) & 15));
                        add_1_sysvq0asl(result_0, X60Qx_2);
                        var X60Qx_3 = getQ_9_sysvq0asl((() => {
                          var _o = allocFixed(8);
                          mem.setU32(_o, 842084606);
                          mem.setU32((_o + 4), strlit_0_I6105018409752412263_webzywwor1);
                          return _o;
                        })(), (mem.u8At(X60Qii_2) & 15));
                        add_1_sysvq0asl(result_0, X60Qx_3);
                      } else {
                        add_1_sysvq0asl(result_0, mem.u8At(X60Qii_2));
                      }
                    }
                    break;
                }
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_1);
            } else {
              break;
            }
          }
        }
      }
    }
  }
  return result_0;
}

function diagsToJson_0_webzywwor1(ds_0) {
  forStmtLabel_0: {
    var result_1 = allocFixed(8);
    nimStrWasMoved(result_1);
    nimStrDestroy(result_1);
    mem.copy(result_1, (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, 23297);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
    {
      whileStmtLabel_1: {
        var X60Qlf_2 = 0;
        var X60Qlf_3 = len_3_Ioyetam_webzywwor1(ds_0);
        var X60Qlf_4 = allocFixed(4);
        mem.setI32(X60Qlf_4, X60Qlf_2);
        {
          while ((mem.i32(X60Qlf_4) < X60Qlf_3)) {
            {
              if ((0 < mem.i32(X60Qlf_4))) {
                add_2_sysvq0asl(result_1, (() => {
                  var _o = allocFixed(8);
                  mem.setU32(_o, 11265);
                  mem.setU32((_o + 4), 0);
                  return _o;
                })());
              }
              add_2_sysvq0asl(result_1, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1814199294);
                mem.setU32((_o + 4), strlit_0_I1077588883665121262_webzywwor1);
                return _o;
              })());
              var X60Qx_4 = getQ_7_Itiua0x_webzywwor1(ds_0, mem.i32(X60Qlf_4));
              var X60Qtmp_0 = allocFixed(8);
              mem.copy(X60Qtmp_0, dollarQ_2_sysvq0asl(mem.i32(X60Qx_4)), 8);
              add_2_sysvq0asl(result_1, X60Qtmp_0);
              add_2_sysvq0asl(result_1, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1663184126);
                mem.setU32((_o + 4), strlit_0_I7115103054454119625_webzywwor1);
                return _o;
              })());
              var X60Qx_5 = getQ_7_Itiua0x_webzywwor1(ds_0, mem.i32(X60Qlf_4));
              var X60Qtmp_1 = allocFixed(8);
              mem.copy(X60Qtmp_1, dollarQ_2_sysvq0asl(mem.i32((X60Qx_5 + 4))), 8);
              add_2_sysvq0asl(result_1, X60Qtmp_1);
              add_2_sysvq0asl(result_1, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 1830956286);
                mem.setU32((_o + 4), strlit_0_I8163788669936926653_webzywwor1);
                return _o;
              })());
              var X60Qx_6 = getQ_7_Itiua0x_webzywwor1(ds_0, mem.i32(X60Qlf_4));
              var X60Qtmp_2 = allocFixed(8);
              mem.copy(X60Qtmp_2, jsonEscape_0_webzywwor1((X60Qx_6 + 8)), 8);
              add_2_sysvq0asl(result_1, X60Qtmp_2);
              add_2_sysvq0asl(result_1, (() => {
                var _o = allocFixed(8);
                mem.setU32(_o, 8200706);
                mem.setU32((_o + 4), 0);
                return _o;
              })());
              nimStrDestroy(X60Qtmp_2);
              nimStrDestroy(X60Qtmp_1);
              nimStrDestroy(X60Qtmp_0);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_4);
          }
        }
      }
    }
  }
  add_2_sysvq0asl(result_1, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 23809);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  return result_1;
}

function parseToStr_0_webzywwor1(src_0, fileField_0, curly_0, diagJson_0) {
  forStmtLabel_0: {
    var result_2 = allocFixed(8);
    nimStrWasMoved(result_2);
    var lexed_0 = allocFixed(16);
    mem.copy(lexed_0, tokenizeD_0_websvfj9k1(src_0), 16);
    var toks_0 = allocFixed(8);
    mem.copy(toks_0, lexed_0, 8);
    eQwasMoved_1_I4bu01z_lex3r1urc1(lexed_0);
    var ds_1 = allocFixed(8);
    mem.copy(ds_1, (lexed_0 + 8), 8);
    eQwasMoved_1_Ir71du1_websvfj9k1((lexed_0 + 8));
    {
      whileStmtLabel_1: {
        var X60Qtmp_3 = allocFixed(8);
        mem.copy(X60Qtmp_3, bracketDiags_0_websvfj9k1(toks_0), 8);
        var X60Qlf_5 = allocFixed(8);
        mem.copy(X60Qlf_5, toOpenArray_1_Iknot7p1_webzywwor1(X60Qtmp_3), 8);
        var X60Qlf_6 = allocFixed(4);
        mem.setI32(X60Qlf_6, 0);
        {
          while (true) {
            var X60Qx_7 = len_6_Irxo9fg_webzywwor1(X60Qlf_5);
            if ((mem.i32(X60Qlf_6) < X60Qx_7)) {
              {
                var X60Qii_2 = getQ_10_Ijbu3gy1_webzywwor1(X60Qlf_5, mem.i32(X60Qlf_6));
                var X60Qx_8 = allocFixed(16);
                mem.copy(X60Qx_8, eQdupQ_SX44iag0websvfj9k1_0_websvfj9k1(X60Qii_2), 16);
                add_0_Ihpko8v1_websvfj9k1(ds_1, X60Qx_8);
              }
              inc_1_I6wjjge_cmdqs323n1(X60Qlf_6);
            } else {
              break;
            }
          }
        }
      }
      eQdestroy_1_I6sickx1_websvfj9k1(X60Qtmp_3);
    }
  }
  nimStrDestroy(diagJson_0);
  var X60Qx_9 = allocFixed(8);
  mem.copy(X60Qx_9, diagsToJson_0_webzywwor1(ds_1), 8);
  mem.copy(diagJson_0, X60Qx_9, 8);
  var ps_0 = allocFixed(20);
  mem.copy(ps_0, initParser_0_parq39nt2(toks_0, fileField_0, curly_0), 20);
  var X60Qx_10 = len_4_sysvq0asl(src_0);
  var b_1 = allocFixed(28);
  mem.copy(b_1, open_1_nifjp9lau1(((Math.imul(X60Qx_10, 4) + 256) | 0), false), 28);
  parseModule_0_parq39nt2(ps_0, b_1);
  nimStrDestroy(result_2);
  var X60Qtmp_4 = allocFixed(28);
  mem.copy(X60Qtmp_4, b_1, 28);
  eQwasmovedQ_SX42uilder0nifjp9lau1_0_webzywwor1(b_1);
  var X60Qx_11 = allocFixed(8);
  mem.copy(X60Qx_11, extract_0_nifjp9lau1(X60Qtmp_4), 8);
  mem.copy(result_2, X60Qx_11, 8);
  eQdestroyQ_SX42uilder0nifjp9lau1_0_webzywwor1(b_1);
  eQdestroyQ_SX50arser0parq39nt2_0_parq39nt2(ps_0);
  eQdestroy_1_I6sickx1_websvfj9k1(ds_1);
  eQdestroy_1_Ie8xo6a1_lex3r1urc1(toks_0);
  eQdestroyQ_AtupleSseq0X49yai4gnSR60X49p6shd31_0_webzywwor1(lexed_0);
  return result_2;
  eQdestroyQ_SX42uilder0nifjp9lau1_0_webzywwor1(b_1);
  eQdestroyQ_SX50arser0parq39nt2_0_parq39nt2(ps_0);
  eQdestroy_1_I6sickx1_websvfj9k1(ds_1);
  eQdestroy_1_Ie8xo6a1_lex3r1urc1(toks_0);
  eQdestroyQ_AtupleSseq0X49yai4gnSR60X49p6shd31_0_webzywwor1(lexed_0);
  return result_2;
}

function npRun_0_webzywwor1() {
  let X60Qtmp_5 = allocFixed(4);
  mem.copy(X60Qtmp_5, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1851744254);
    mem.setU32((_o + 4), strlit_0_I16858515255358452405_webzywwor1);
    return _o;
  })()), 4);
  let src_1 = allocFixed(8);
  mem.copy(src_1, toStr_0_jsfc0lwq21(X60Qtmp_5), 8);
  let X60Qtmp_6 = allocFixed(4);
  mem.copy(X60Qtmp_6, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1851744254);
    mem.setU32((_o + 4), strlit_0_I9665133714172714337_webzywwor1);
    return _o;
  })()), 4);
  let fileField_1 = allocFixed(8);
  mem.copy(fileField_1, toStr_0_jsfc0lwq21(X60Qtmp_6), 8);
  let X60Qx_12 = len_4_sysvq0asl(fileField_1);
  if ((X60Qx_12 === 0)) {
    nimStrDestroy(fileField_1);
    mem.copy(fileField_1, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 778988030);
      mem.setU32((_o + 4), strlit_0_I12157574297857663135_webzywwor1);
      return _o;
    })(), 8);
  }
  let X60Qtmp_8 = allocFixed(4);
  mem.copy(X60Qtmp_8, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1851744254);
    mem.setU32((_o + 4), strlit_0_I12129343431845544526_webzywwor1);
    return _o;
  })()), 4);
  let X60Qtmp_7 = allocFixed(8);
  mem.copy(X60Qtmp_7, toStr_0_jsfc0lwq21(X60Qtmp_8), 8);
  let X60Qx_13 = len_4_sysvq0asl(X60Qtmp_7);
  let curly_1 = (!(X60Qx_13 === 0));
  let diagJson_1 = allocFixed(8);
  mem.setU32(diagJson_1, 0);
  mem.setU32((diagJson_1 + 4), 0);
  let outp_0 = allocFixed(8);
  mem.copy(outp_0, parseToStr_0_webzywwor1(src_1, fileField_1, curly_1, diagJson_1), 8);
  let g_0 = allocFixed(4);
  mem.copy(g_0, global_0_jsfc0lwq21((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869375486);
    mem.setU32((_o + 4), strlit_0_I16664880105326712979_webzywwor1);
    return _o;
  })()), 4);
  let X60Qtmp_9 = allocFixed(4);
  mem.copy(X60Qtmp_9, toJs_3_jsfc0lwq21(outp_0), 4);
  set_0_jsfc0lwq21(g_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1851744254);
    mem.setU32((_o + 4), strlit_0_I7810566879425797473_webzywwor1);
    return _o;
  })(), X60Qtmp_9);
  let X60Qtmp_10 = allocFixed(4);
  mem.copy(X60Qtmp_10, toJs_3_jsfc0lwq21(diagJson_1), 4);
  set_0_jsfc0lwq21(g_0, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1851744254);
    mem.setU32((_o + 4), strlit_0_I6187027680374537400_webzywwor1);
    return _o;
  })(), X60Qtmp_10);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_10);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_9);
  eQdestroy_0_jsfc0lwq21(g_0);
  nimStrDestroy(outp_0);
  nimStrDestroy(diagJson_1);
  nimStrDestroy(X60Qtmp_7);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_8);
  nimStrDestroy(fileField_1);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_6);
  nimStrDestroy(src_1);
  eQdestroy_0_jsfc0lwq21(X60Qtmp_5);
}

function len_3_Ioyetam_webzywwor1(s_5) {
  let result_3;
  result_3 = mem.i32(s_5);
  return result_3;
}

function getQ_7_Itiua0x_webzywwor1(s_6, i_4) {
  let X60Qx_14;
  if ((i_4 < mem.i32(s_6))) {
    X60Qx_14 = (0 <= i_4);
  } else {
    X60Qx_14 = false;
  }
  if ((!X60Qx_14)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14532204288076119502_envto7w6l1);
      return _o;
    })());
  }
  let result_4;
  result_4 = (mem.u32((s_6 + 4)) + (i_4 * 16));
  return result_4;
}

function toOpenArray_1_Iknot7p1_webzywwor1(s_7) {
  let result_5 = allocFixed(8);
  let X60Qx_15 = rawData_0_Inu9jhg1_webzywwor1(s_7);
  mem.copy(result_5, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, X60Qx_15);
    mem.setI32((_o + 4), mem.i32(s_7));
    return _o;
  })(), 8);
  return result_5;
}

function rawData_0_Inu9jhg1_webzywwor1(s_11) {
  let result_8;
  result_8 = mem.u32((s_11 + 4));
  return result_8;
}

function len_6_Irxo9fg_webzywwor1(a_9) {
  let result_9;
  result_9 = mem.i32((a_9 + 4));
  return result_9;
}

function getQ_10_Ijbu3gy1_webzywwor1(x_5, idx_3) {
  let X60Qx_19;
  if ((0 <= idx_3)) {
    X60Qx_19 = (idx_3 < mem.i32((x_5 + 4)));
  } else {
    X60Qx_19 = false;
  }
  if ((!X60Qx_19)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14694606176902936784_has9tn57v);
      return _o;
    })());
  }
  let result_10;
  result_10 = (mem.u32(x_5) + (idx_3 * 16));
  return result_10;
}

function eQdestroyQ_AtupleSseq0X49yai4gnSR60X49p6shd31_0_webzywwor1(dest_0) {
  eQdestroy_1_Ie8xo6a1_lex3r1urc1(dest_0);
  eQdestroy_1_I6sickx1_websvfj9k1((dest_0 + 8));
}

function eQdestroyQ_SX42uilder0nifjp9lau1_0_webzywwor1(dest_0) {
  nimStrDestroy((dest_0 + 12));
  nimStrDestroy(dest_0);
}

function eQwasmovedQ_SX42uilder0nifjp9lau1_0_webzywwor1(dest_0) {
  nimStrWasMoved(dest_0);
  nimStrWasMoved((dest_0 + 12));
}

let X60QiniGuard_0_webzywwor1 = allocFixed(1);

function X60Qini_0_webzywwor1() {
  if (mem.u8At(X60QiniGuard_0_webzywwor1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_webzywwor1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_nifjp9lau1();
  X60Qini_0_vfsc9jn7();
  X60Qini_0_tok9e79hf();
  X60Qini_0_lex3r1urc1();
  X60Qini_0_parq39nt2();
  X60Qini_0_websvfj9k1();
  X60Qini_0_jsfc0lwq21();
  npRun_0_webzywwor1();
}

let cmdCount = allocFixed(4);

let cmdLine = allocFixed(4);

let nimEnviron = allocFixed(4);

function main(X60Qargc_0_webzywwor1, X60Qargv_0_webzywwor1, X60Qenvp_0_webzywwor1) {
  mem.setI32(cmdCount, X60Qargc_0_webzywwor1);
  mem.setU32(cmdLine, X60Qargv_0_webzywwor1);
  mem.setU32(nimEnviron, X60Qenvp_0_webzywwor1);
  X60Qini_0_webzywwor1();
  nimFlushStdStreams();
  return 0;
}
// generated by lengc (js backend) from wid623gv.c.nif

let X60QiniGuard_0_wid623gv = allocFixed(1);

function X60Qini_0_wid623gv() {
  if (mem.u8At(X60QiniGuard_0_wid623gv)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_wid623gv, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from cmdqs323n1.c.nif

function newSeqUninit_0_Im3cqd9_cmdqs323n1(size_1) {
  let result_4 = allocFixed(8);
  if ((size_1 === 0)) {
    mem.copy(result_4, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_1);
      mem.setU32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    let memSize_0 = memSizeInBytes_0_I7me00i_cmdqs323n1(size_1);
    let X60Qx_21 = alloc_1_sysvq0asl(memSize_0);
    mem.copy(result_4, (() => {
      let _o = allocFixed(8);
      mem.setI32(_o, size_1);
      mem.setU32((_o + 4), X60Qx_21);
      return _o;
    })(), 8);
    if ((!(mem.u32((result_4 + 4)) === 0))) {
      let X60Qx_22 = allocFixed(8);
      mem.setU32(X60Qx_22, 1634036990);
      mem.setU32((X60Qx_22 + 4), strlit_0_I15750996627617194403_cmdqs323n1);
    } else {
      mem.setI32(result_4, 0);
      _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_0);
    }
  }
  return result_4;
}

function inc_1_I6wjjge_cmdqs323n1(x_2) {
  mem.setI32(x_2, ((mem.i32(x_2) + 1) | 0));
}

function move_0_Isxfjyr_cmdqs323n1(x_3) {
  let result_5 = allocFixed(8);
  mem.copy(result_5, x_3, 8);
  nimStrWasMoved(x_3);
  return result_5;
}

function add_0_Ig6072n_cmdqs323n1(s_1, elem_1) {
  let L_0 = mem.i32(s_1);
  let X60Qx_23 = capInBytes_0_Ih2sbn01_cmdqs323n1(s_1);
  if ((X60Qx_23 < ((Math.imul(L_0, 8) + 8) | 0))) {
    let X60Qx_24 = resize_0_I4buliy_cmdqs323n1(s_1, 1);
    if ((!X60Qx_24)) {
      nimStrDestroy(elem_1);
      return;
    }
  }
  inc_1_I6wjjge_cmdqs323n1(s_1);
  mem.copy((mem.u32((s_1 + 4)) + (L_0 * 8)), elem_1, 8);
}

function memSizeInBytes_0_I7me00i_cmdqs323n1(size_3) {
  let result_6;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = Math.imul(size_3, 8);
  result_6 = X60QconstRefTemp_0;
  if (false) {
    result_6 = 2147483647;
  }
  return result_6;
}

function capInBytes_0_Ih2sbn01_cmdqs323n1(s_3) {
  let result_7;
  let X60Qx_1;
  if ((!(mem.u32((s_3 + 4)) === 0))) {
    let X60Qx_25 = allocatedSize_0_sysvq0asl(mem.u32((s_3 + 4)));
    X60Qx_1 = X60Qx_25;
  } else {
    X60Qx_1 = 0;
  }
  result_7 = X60Qx_1;
  return result_7;
}

function resize_0_I4buliy_cmdqs323n1(dest_1, addedElements_1) {
  let result_8;
  let X60Qx_26 = capInBytes_0_Ih2sbn01_cmdqs323n1(dest_1);
  let oldCap_0 = Math.trunc((X60Qx_26 / 8));
  let newCap_0 = recalcCap_0_sysvq0asl(oldCap_0, addedElements_1);
  let memSize_1 = memSizeInBytes_0_I7me00i_cmdqs323n1(newCap_0);
  let X60Qx_27 = realloc_1_sysvq0asl(mem.u32((dest_1 + 4)), memSize_1);
  mem.setU32((dest_1 + 4), X60Qx_27);
  if ((mem.u32((dest_1 + 4)) === 0)) {
    mem.setI32(dest_1, 0);
    _fns[mem.u32(oomHandler_0_sysvq0asl)](memSize_1);
    result_8 = false;
  } else {
    result_8 = true;
  }
  return result_8;
}

function eQdestroy_1_Ivioh0a_cmdqs323n1(s_6) {
  if ((!(mem.u32((s_6 + 4)) === 0))) {
    whileStmtLabel_0: {
      var i_4 = allocFixed(4);
      mem.setI32(i_4, 0);
      {
        while ((mem.i32(i_4) < mem.i32(s_6))) {
          nimStrDestroy((mem.u32((s_6 + 4)) + (mem.i32(i_4) * 8)));
          inc_1_I6wjjge_cmdqs323n1(i_4);
        }
      }
    }
    dealloc_1_sysvq0asl(mem.u32((s_6 + 4)));
  }
}

function eQwasMoved_1_I5vdnla_cmdqs323n1(s_7) {
  mem.setI32(s_7, 0);
  mem.setU32((s_7 + 4), 0);
}

function eQdup_1_Imq0s4c_cmdqs323n1(a_4) {
  whileStmtLabel_0: {
    var result_9 = allocFixed(8);
    var X60Qx_28 = allocFixed(8);
    mem.copy(X60Qx_28, newSeqUninit_0_Im3cqd9_cmdqs323n1(mem.i32(a_4)), 8);
    mem.copy(result_9, X60Qx_28, 8);
    var i_5 = allocFixed(4);
    mem.setI32(i_5, 0);
    {
      while ((mem.i32(i_5) < mem.i32(a_4))) {
        var X60Qx_29 = allocFixed(8);
        mem.copy(X60Qx_29, nimStrDup((mem.u32((a_4 + 4)) + (mem.i32(i_5) * 8))), 8);
        mem.copy((mem.u32((result_9 + 4)) + (mem.i32(i_5) * 8)), X60Qx_29, 8);
        inc_1_I6wjjge_cmdqs323n1(i_5);
      }
    }
  }
  return result_9;
}

let X60QiniGuard_0_cmdqs323n1 = allocFixed(1);

function X60Qini_0_cmdqs323n1() {
  if (mem.u8At(X60QiniGuard_0_cmdqs323n1)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_cmdqs323n1, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_wid623gv();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_pososrh1q1();
  X60Qini_0_str7j0ifg();
}
// generated by lengc (js backend) from ossk30t39.c.nif

let X60QiniGuard_0_ossk30t39 = allocFixed(1);

function X60Qini_0_ossk30t39() {
  if (mem.u8At(X60QiniGuard_0_ossk30t39)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_ossk30t39, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from sysvq0asl.c.nif

function min_2_sysvq0asl(x_204, y_161) {
  let result_5;
  let X60Qx_2;
  if ((x_204 <= y_161)) {
    X60Qx_2 = x_204;
  } else {
    X60Qx_2 = y_161;
  }
  result_5 = X60Qx_2;
  return result_5;
}

function max_2_sysvq0asl(x_211, y_168) {
  let result_12;
  let X60Qx_8;
  if ((y_168 <= x_211)) {
    X60Qx_8 = x_211;
  } else {
    X60Qx_8 = y_168;
  }
  result_12 = X60Qx_8;
  return result_12;
}

function dollarQ_0_sysvq0asl(x_224) {
  var result_19 = allocFixed(8);
  nimStrWasMoved(result_19);
  nimStrDestroy(result_19);
  mem.copy(result_19, (() => {
    var _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  if ((x_224 < 10n)) {
    nimStrDestroy(result_19);
    var X60Qx_57 = nimIcheckB(Number(BigInt.asIntN(32, x_224)), 9);
    var X60Qx_58 = allocFixed(8);
    mem.copy(X60Qx_58, substr_0_sysvq0asl((NegTen_0_sysvq0asl + (X60Qx_57 * 8)), 1, 1), 8);
    mem.copy(result_19, X60Qx_58, 8);
  } else {
    whileStmtLabel_1: {
      whileStmtLabel_0: {
        var y_208 = x_224;
        {
          while (true) {
            add_1_sysvq0asl(result_19, Number(BigInt.asUintN(8, BigInt.asUintN(64, ((y_208 % 10n) + 48n)))));
            y_208 = (y_208 / 10n);
            if ((y_208 === 0n)) {
              break whileStmtLabel_0;
            }
          }
        }
      }
      var X60Qx_59 = len_4_sysvq0asl(result_19);
      var last_3 = ((X60Qx_59 - 1) | 0);
      var i_25 = allocFixed(4);
      mem.setI32(i_25, 0);
      var X60Qx_60 = len_4_sysvq0asl(result_19);
      var b_29 = Math.trunc((X60Qx_60 / 2));
      {
        while ((mem.i32(i_25) < b_29)) {
          var ch_1 = getQ_9_sysvq0asl(result_19, mem.i32(i_25));
          var X60Qx_61 = getQ_9_sysvq0asl(result_19, ((last_3 - mem.i32(i_25)) | 0));
          putQ_9_sysvq0asl(result_19, mem.i32(i_25), X60Qx_61);
          putQ_9_sysvq0asl(result_19, ((last_3 - mem.i32(i_25)) | 0), ch_1);
          inc_1_I6wjjge_cmdqs323n1(i_25);
        }
      }
    }
  }
  return result_19;
}

function dollarQ_1_sysvq0asl(x_225) {
  let result_20 = allocFixed(8);
  nimStrWasMoved(result_20);
  if ((x_225 < 0n)) {
    if ((-10n < x_225)) {
      nimStrDestroy(result_20);
      let X60Qx_62 = nimIcheckB(Number(BigInt.asIntN(32, BigInt.asIntN(64, (-x_225)))), 9);
      let X60Qx_63 = allocFixed(8);
      mem.copy(X60Qx_63, nimStrDup((NegTen_0_sysvq0asl + (X60Qx_62 * 8))), 8);
      mem.copy(result_20, X60Qx_63, 8);
    } else {
      if ((x_225 === -9223372036854775808n)) {
        nimStrDestroy(result_20);
        let X60Qtmp_0 = allocFixed(8);
        mem.copy(X60Qtmp_0, dollarQ_0_sysvq0asl(BigInt.asUintN(64, x_225)), 8);
        let X60Qx_64 = allocFixed(8);
        mem.copy(X60Qx_64, ampQ_0_sysvq0asl((() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 11521);
          mem.setU32((_o + 4), 0);
          return _o;
        })(), X60Qtmp_0), 8);
        mem.copy(result_20, X60Qx_64, 8);
        nimStrDestroy(X60Qtmp_0);
      } else {
        nimStrDestroy(result_20);
        let X60Qtmp_1 = allocFixed(8);
        mem.copy(X60Qtmp_1, dollarQ_1_sysvq0asl(BigInt.asIntN(64, (0n - x_225))), 8);
        let X60Qx_65 = allocFixed(8);
        mem.copy(X60Qx_65, ampQ_0_sysvq0asl((() => {
          let _o = allocFixed(8);
          mem.setU32(_o, 11521);
          mem.setU32((_o + 4), 0);
          return _o;
        })(), X60Qtmp_1), 8);
        mem.copy(result_20, X60Qx_65, 8);
        nimStrDestroy(X60Qtmp_1);
      }
    }
  } else {
    if ((x_225 < 10n)) {
      nimStrDestroy(result_20);
      mem.copy(result_20, (() => {
        let _o = allocFixed(8);
        mem.setU32(_o, 0);
        mem.setU32((_o + 4), 0);
        return _o;
      })(), 8);
      add_1_sysvq0asl(result_20, Number(BigInt.asUintN(8, BigInt.asIntN(64, (x_225 + 48n)))));
    } else {
      nimStrDestroy(result_20);
      let X60Qx_66 = allocFixed(8);
      mem.copy(X60Qx_66, dollarQ_0_sysvq0asl(BigInt.asUintN(64, x_225)), 8);
      mem.copy(result_20, X60Qx_66, 8);
    }
  }
  return result_20;
}

function dollarQ_2_sysvq0asl(x_226) {
  let result_21 = allocFixed(8);
  nimStrWasMoved(result_21);
  nimStrDestroy(result_21);
  let X60Qx_67 = allocFixed(8);
  mem.copy(X60Qx_67, dollarQ_1_sysvq0asl(BigInt(x_226)), 8);
  mem.copy(result_21, X60Qx_67, 8);
  return result_21;
}

function nimNoopFlush_0_sysvq0asl() {
}

let gExitFlush_0_sysvq0asl = allocFixed(4);

mem.setU32(gExitFlush_0_sysvq0asl, _fnid(nimNoopFlush_0_sysvq0asl));

function nimFlushStdStreams() {
  _fns[mem.u32(gExitFlush_0_sysvq0asl)]();
}

function cExit_0_sysvq0asl(code_1) {
  _fns[mem.u32(gExitFlush_0_sysvq0asl)]();
  exit(code_1);
}

function cAbort_0_sysvq0asl() {
  _fns[mem.u32(gExitFlush_0_sysvq0asl)]();
  abort();
}

function copyMem_0_sysvq0asl(dest_4, src_3, size_3) {
  memcpy(dest_4, src_3, size_3);
}

function cmpMem_0_sysvq0asl(a_5, b_6, size_5) {
  let result_29;
  let X60Qx_77 = memcmp(a_5, b_6, size_5);
  result_29 = X60Qx_77;
  return result_29;
}

function zeroMem_0_sysvq0asl(dest_6, size_6) {
  memset(dest_6, 0, size_6);
}

function raiseOutOfMem_0_sysvq0asl() {
  cAbort_0_sysvq0asl();
}

function align_0_sysvq0asl(address_0, alignment_0) {
  let result_30;
  result_30 = (((address_0 + ((alignment_0 - 1) | 0)) | 0) & (~((alignment_0 - 1) | 0)));
  return result_30;
}

function roundup_0_sysvq0asl(x_297, v_0) {
  let result_31;
  result_31 = (((x_297 + ((v_0 - 1) | 0)) | 0) & (~((v_0 - 1) | 0)));
  return result_31;
}

function osAllocPages_0_sysvq0asl(size_7) {
  let result_32;
  let X60Qx_78 = mmap(0, size_7, (1 | 2), ((32 | 2) | 0), -1, 0);
  result_32 = X60Qx_78;
  let X60Qx_79;
  if ((result_32 === 0)) {
    X60Qx_79 = true;
  } else {
    X60Qx_79 = (result_32 === -1);
  }
  if (X60Qx_79) {
    raiseOutOfMem_0_sysvq0asl();
  }
  return result_32;
}

function osTryAllocPages_0_sysvq0asl(size_8) {
  let result_33;
  let X60Qx_80 = mmap(0, size_8, (1 | 2), ((32 | 2) | 0), -1, 0);
  result_33 = X60Qx_80;
  if ((result_33 === -1)) {
    result_33 = 0;
  }
  return result_33;
}

function osDeallocPages_0_sysvq0asl(p_9, size_9) {
}

function msbit_0_sysvq0asl(x_302) {
  let result_34;
  let X60Qx_13;
  if ((x_302 <= 65535)) {
    let X60Qx_14;
    if ((x_302 <= 255)) {
      X60Qx_14 = 0;
    } else {
      X60Qx_14 = 8;
    }
    X60Qx_13 = X60Qx_14;
  } else {
    let X60Qx_15;
    if ((x_302 <= 16777215)) {
      X60Qx_15 = 16;
    } else {
      X60Qx_15 = 24;
    }
    X60Qx_13 = X60Qx_15;
  }
  let a_74 = X60Qx_13;
  let X60Qx_81 = nimUcheckB(((x_302 >>> a_74) & 255), 255);
  result_34 = ((mem.i8((fsLookupTable_0_sysvq0asl + X60Qx_81)) + a_74) | 0);
  return result_34;
}

function lsbit_0_sysvq0asl(x_303) {
  let result_35;
  let X60Qx_82 = msbit_0_sysvq0asl(((x_303 & ((((~x_303) >>> 0) + 1) >>> 0)) >>> 0));
  result_35 = X60Qx_82;
  return result_35;
}

function setBit_0_sysvq0asl(nr_0, dest_7) {
  mem.setU32(dest_7, ((mem.u32(dest_7) | ((1 << (nr_0 & 31)) >>> 0)) >>> 0));
}

function clearBit_0_sysvq0asl(nr_1, dest_8) {
  mem.setU32(dest_8, ((mem.u32(dest_8) & ((~((1 << (nr_1 & 31)) >>> 0)) >>> 0)) >>> 0));
}

function mappingSearch_0_sysvq0asl(r_0, fl_0, sl_0) {
  let X60Qx_83 = msbit_0_sysvq0asl(mem.i32(r_0));
  let X60Qx_84 = roundup_0_sysvq0asl((1 << ((X60Qx_83 - 5) | 0)), 4096);
  let t_3 = ((X60Qx_84 - 1) | 0);
  mem.setI32(r_0, ((mem.i32(r_0) + t_3) | 0));
  mem.setI32(r_0, (mem.i32(r_0) & (~t_3)));
  let X60Qx_85 = min_2_sysvq0asl(mem.i32(r_0), 1056964608);
  mem.setI32(r_0, X60Qx_85);
  let X60Qx_86 = msbit_0_sysvq0asl(mem.i32(r_0));
  mem.setI32(fl_0, X60Qx_86);
  mem.setI32(sl_0, (((mem.i32(r_0) >> ((mem.i32(fl_0) - 5) | 0)) - 32) | 0));
  dec_0_Ig5i8xp_ospaexnw61(fl_0, 6);
}

function mappingInsert_0_sysvq0asl(r_1) {
  let result_36 = allocFixed(8);
  let fl_4 = msbit_0_sysvq0asl(r_1);
  let sl_5 = (((r_1 >> ((fl_4 - 5) | 0)) - 32) | 0);
  fl_4 = ((fl_4 - 6) | 0);
  mem.copy(result_36, (() => {
    let _o = allocFixed(8);
    mem.setI32(_o, fl_4);
    mem.setI32((_o + 4), sl_5);
    return _o;
  })(), 8);
  return result_36;
}

function findSuitableBlock_0_sysvq0asl(a_6, fl_1, sl_1) {
  let result_37;
  let X60Qx_87 = nimIcheckB(mem.i32(fl_1), 23);
  let tmp_2 = ((mem.u32(((a_6 + 2052) + (X60Qx_87 * 4))) & ((((~0) >>> 0) << mem.i32(sl_1)) >>> 0)) >>> 0);
  result_37 = 0;
  if ((!(tmp_2 === 0))) {
    let X60Qx_88 = lsbit_0_sysvq0asl(tmp_2);
    mem.setI32(sl_1, X60Qx_88);
    let X60Qx_89 = nimIcheckB(mem.i32(fl_1), 23);
    let X60Qx_90 = nimIcheckB(mem.i32(sl_1), 31);
    result_37 = mem.u32((((a_6 + 2148) + (X60Qx_89 * 128)) + (X60Qx_90 * 4)));
  } else {
    let X60Qx_91 = lsbit_0_sysvq0asl(((mem.u32((a_6 + 2048)) & ((((~0) >>> 0) << ((mem.i32(fl_1) + 1) | 0)) >>> 0)) >>> 0));
    mem.setI32(fl_1, X60Qx_91);
    if ((0 < mem.i32(fl_1))) {
      let X60Qx_92 = nimIcheckB(mem.i32(fl_1), 23);
      let X60Qx_93 = lsbit_0_sysvq0asl(mem.u32(((a_6 + 2052) + (X60Qx_92 * 4))));
      mem.setI32(sl_1, X60Qx_93);
      let X60Qx_94 = nimIcheckB(mem.i32(fl_1), 23);
      let X60Qx_95 = nimIcheckB(mem.i32(sl_1), 31);
      result_37 = mem.u32((((a_6 + 2148) + (X60Qx_94 * 128)) + (X60Qx_95 * 4)));
    }
  }
  return result_37;
}

function removeChunkFromMatrix_0_sysvq0asl(a_7, b_7) {
  let X60Qtmptup_0 = allocFixed(8);
  mem.copy(X60Qtmptup_0, mappingInsert_0_sysvq0asl(mem.i32((b_7 + 4))), 8);
  let fl_5 = mem.i32(X60Qtmptup_0);
  let sl_6 = mem.i32((X60Qtmptup_0 + 4));
  if ((!(mem.u32((b_7 + 12)) === 0))) {
    mem.setU32((mem.u32((b_7 + 12)) + 16), mem.u32((b_7 + 16)));
  }
  if ((!(mem.u32((b_7 + 16)) === 0))) {
    mem.setU32((mem.u32((b_7 + 16)) + 12), mem.u32((b_7 + 12)));
  }
  let X60Qx_96 = nimIcheckB(fl_5, 23);
  let X60Qx_97 = nimIcheckB(sl_6, 31);
  if ((mem.u32((((a_7 + 2148) + (X60Qx_96 * 128)) + (X60Qx_97 * 4))) === b_7)) {
    let X60Qx_98 = nimIcheckB(fl_5, 23);
    let X60Qx_99 = nimIcheckB(sl_6, 31);
    mem.setU32((((a_7 + 2148) + (X60Qx_98 * 128)) + (X60Qx_99 * 4)), mem.u32((b_7 + 12)));
    let X60Qx_100 = nimIcheckB(fl_5, 23);
    let X60Qx_101 = nimIcheckB(sl_6, 31);
    if ((mem.u32((((a_7 + 2148) + (X60Qx_100 * 128)) + (X60Qx_101 * 4))) === 0)) {
      let X60Qx_102 = nimIcheckB(fl_5, 23);
      clearBit_0_sysvq0asl(sl_6, ((a_7 + 2052) + (X60Qx_102 * 4)));
      let X60Qx_103 = nimIcheckB(fl_5, 23);
      if ((mem.u32(((a_7 + 2052) + (X60Qx_103 * 4))) === 0)) {
        clearBit_0_sysvq0asl(fl_5, (a_7 + 2048));
      }
    }
  }
  mem.setU32((b_7 + 16), 0);
  mem.setU32((b_7 + 12), 0);
}

function removeChunkFromMatrix2_0_sysvq0asl(a_8, b_8, fl_3, sl_3) {
  let X60Qx_104 = nimIcheckB(fl_3, 23);
  let X60Qx_105 = nimIcheckB(sl_3, 31);
  mem.setU32((((a_8 + 2148) + (X60Qx_104 * 128)) + (X60Qx_105 * 4)), mem.u32((b_8 + 12)));
  let X60Qx_106 = nimIcheckB(fl_3, 23);
  let X60Qx_107 = nimIcheckB(sl_3, 31);
  if ((!(mem.u32((((a_8 + 2148) + (X60Qx_106 * 128)) + (X60Qx_107 * 4))) === 0))) {
    let X60Qx_108 = nimIcheckB(fl_3, 23);
    let X60Qx_109 = nimIcheckB(sl_3, 31);
    mem.setU32((mem.u32((((a_8 + 2148) + (X60Qx_108 * 128)) + (X60Qx_109 * 4))) + 16), 0);
  } else {
    let X60Qx_110 = nimIcheckB(fl_3, 23);
    clearBit_0_sysvq0asl(sl_3, ((a_8 + 2052) + (X60Qx_110 * 4)));
    let X60Qx_111 = nimIcheckB(fl_3, 23);
    if ((mem.u32(((a_8 + 2052) + (X60Qx_111 * 4))) === 0)) {
      clearBit_0_sysvq0asl(fl_3, (a_8 + 2048));
    }
  }
  mem.setU32((b_8 + 16), 0);
  mem.setU32((b_8 + 12), 0);
}

function addChunkToMatrix_0_sysvq0asl(a_9, b_9) {
  let X60Qtmptup_1 = allocFixed(8);
  mem.copy(X60Qtmptup_1, mappingInsert_0_sysvq0asl(mem.i32((b_9 + 4))), 8);
  let fl_6 = mem.i32(X60Qtmptup_1);
  let sl_7 = mem.i32((X60Qtmptup_1 + 4));
  mem.setU32((b_9 + 16), 0);
  let X60Qx_112 = nimIcheckB(fl_6, 23);
  let X60Qx_113 = nimIcheckB(sl_7, 31);
  mem.setU32((b_9 + 12), mem.u32((((a_9 + 2148) + (X60Qx_112 * 128)) + (X60Qx_113 * 4))));
  let X60Qx_114 = nimIcheckB(fl_6, 23);
  let X60Qx_115 = nimIcheckB(sl_7, 31);
  if ((!(mem.u32((((a_9 + 2148) + (X60Qx_114 * 128)) + (X60Qx_115 * 4))) === 0))) {
    let X60Qx_116 = nimIcheckB(fl_6, 23);
    let X60Qx_117 = nimIcheckB(sl_7, 31);
    mem.setU32((mem.u32((((a_9 + 2148) + (X60Qx_116 * 128)) + (X60Qx_117 * 4))) + 16), b_9);
  }
  let X60Qx_118 = nimIcheckB(fl_6, 23);
  let X60Qx_119 = nimIcheckB(sl_7, 31);
  mem.setU32((((a_9 + 2148) + (X60Qx_118 * 128)) + (X60Qx_119 * 4)), b_9);
  let X60Qx_120 = nimIcheckB(fl_6, 23);
  setBit_0_sysvq0asl(sl_7, ((a_9 + 2052) + (X60Qx_120 * 4)));
  setBit_0_sysvq0asl(fl_6, (a_9 + 2048));
}

function incCurrMem_0_sysvq0asl(a_10, bytes_0) {
  inc_0_Iloplki_party5a2l1((a_10 + 5224), bytes_0);
}

function decCurrMem_0_sysvq0asl(a_11, bytes_1) {
  let X60Qx_121 = max_2_sysvq0asl(mem.i32((a_11 + 5228)), mem.i32((a_11 + 5224)));
  mem.setI32((a_11 + 5228), X60Qx_121);
  dec_0_Ig5i8xp_ospaexnw61((a_11 + 5224), bytes_1);
}

function allocPages_0_sysvq0asl(a_13, size_11) {
  let result_39;
  let X60Qx_123 = osAllocPages_0_sysvq0asl(size_11);
  result_39 = X60Qx_123;
  return result_39;
}

function tryAllocPages_0_sysvq0asl(a_14, size_12) {
  let result_40;
  let X60Qx_124 = osTryAllocPages_0_sysvq0asl(size_12);
  result_40 = X60Qx_124;
  return result_40;
}

function llAlloc_0_sysvq0asl(a_15, size_13) {
  let result_41;
  let X60Qx_125;
  if ((mem.u32((a_15 + 5220)) === 0)) {
    X60Qx_125 = true;
  } else {
    X60Qx_125 = (mem.i32(mem.u32((a_15 + 5220))) < size_13);
  }
  if (X60Qx_125) {
    let old_1 = mem.u32((a_15 + 5220));
    let X60Qx_126 = allocPages_0_sysvq0asl(a_15, 4096);
    mem.setU32((a_15 + 5220), X60Qx_126);
    incCurrMem_0_sysvq0asl(a_15, 4096);
    mem.setI32(mem.u32((a_15 + 5220)), (4084 | 0));
    mem.setI32((mem.u32((a_15 + 5220)) + 4), 12);
    mem.setU32((mem.u32((a_15 + 5220)) + 8), old_1);
  }
  result_41 = ((mem.u32((a_15 + 5220)) + mem.i32((mem.u32((a_15 + 5220)) + 4))) | 0);
  dec_0_Ig5i8xp_ospaexnw61(mem.u32((a_15 + 5220)), size_13);
  inc_0_Iloplki_party5a2l1((mem.u32((a_15 + 5220)) + 4), size_13);
  zeroMem_0_sysvq0asl(result_41, size_13);
  return result_41;
}

function addHeapLink_0_sysvq0asl(a_16, p_10, size_14) {
  whileStmtLabel_0: {
    var result_42;
    var it_0 = (a_16 + 6280);
    {
      while (true) {
        var X60Qx_127;
        if ((!(it_0 === 0))) {
          X60Qx_127 = ((((29 | 0) + 1) | 0) <= mem.i32(it_0));
        } else {
          X60Qx_127 = false;
        }
        if (X60Qx_127) {
          it_0 = mem.u32((it_0 + 244));
        } else {
          break;
        }
      }
    }
  }
  if ((it_0 === 0)) {
    var X60Qx_128 = llAlloc_0_sysvq0asl(a_16, 248);
    var n_7 = X60Qx_128;
    mem.setU32((n_7 + 244), mem.u32(((a_16 + 6280) + 244)));
    mem.setU32(((a_16 + 6280) + 244), n_7);
    var X60Qx_129 = nimIcheckB(0, 29);
    mem.copy(((n_7 + 4) + (X60Qx_129 * 8)), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, p_10);
      mem.setI32((_o + 4), size_14);
      return _o;
    })(), 8);
    mem.setI32(n_7, 1);
    result_42 = n_7;
  } else {
    var L_0 = mem.i32(it_0);
    var X60Qx_130 = nimIcheckB(L_0, 29);
    mem.copy(((it_0 + 4) + (X60Qx_130 * 8)), (() => {
      var _o = allocFixed(8);
      mem.setU32(_o, p_10);
      mem.setI32((_o + 4), size_14);
      return _o;
    })(), 8);
    inc_1_I6wjjge_cmdqs323n1(it_0);
    result_42 = it_0;
  }
  return result_42;
}

function intSetGet_0_sysvq0asl(t_0, key_0) {
  whileStmtLabel_0: {
    var result_43;
    var X60Qx_131 = nimIcheckB((key_0 & 255), 255);
    var it_2 = mem.u32((t_0 + (X60Qx_131 * 4)));
    {
      while ((!(it_2 === 0))) {
        if ((mem.i32((it_2 + 4)) === key_0)) {
          return it_2;
        }
        it_2 = mem.u32(it_2);
      }
    }
  }
  result_43 = 0;
  return result_43;
}

function intSetPut_0_sysvq0asl(a_18, key_1) {
  let result_44;
  let X60Qx_132 = intSetGet_0_sysvq0asl((a_18 + 5248), key_1);
  result_44 = X60Qx_132;
  if ((result_44 === 0)) {
    let X60Qx_133 = llAlloc_0_sysvq0asl(a_18, 72);
    result_44 = X60Qx_133;
    let X60Qx_134 = nimIcheckB((key_1 & 255), 255);
    mem.setU32(result_44, mem.u32(((a_18 + 5248) + (X60Qx_134 * 4))));
    let X60Qx_135 = nimIcheckB((key_1 & 255), 255);
    mem.setU32(((a_18 + 5248) + (X60Qx_135 * 4)), result_44);
    mem.setI32((result_44 + 4), key_1);
  }
  return result_44;
}

function contains_1_sysvq0asl(s_4, key_2) {
  let result_45;
  let t_4 = intSetGet_0_sysvq0asl(s_4, (key_2 >> 9));
  if ((!(t_4 === 0))) {
    let u_1 = (key_2 & 511);
    let X60Qx_136 = nimIcheckB((u_1 >> 5), 15);
    result_45 = (!(((mem.u32(((t_4 + 8) + (X60Qx_136 * 4))) & ((1 << (u_1 & 31)) >>> 0)) >>> 0) === 0));
  } else {
    result_45 = false;
  }
  return result_45;
}

function incl_2_sysvq0asl(a_19, key_3) {
  let t_5 = intSetPut_0_sysvq0asl(a_19, (key_3 >> 9));
  let u_2 = (key_3 & 511);
  let X60Qx_137 = nimIcheckB((u_2 >> 5), 15);
  let X60Qx_138 = nimIcheckB((u_2 >> 5), 15);
  mem.setU32(((t_5 + 8) + (X60Qx_137 * 4)), ((mem.u32(((t_5 + 8) + (X60Qx_138 * 4))) | ((1 << (u_2 & 31)) >>> 0)) >>> 0));
}

function excl_2_sysvq0asl(s_5, key_4) {
  let t_6 = intSetGet_0_sysvq0asl(s_5, (key_4 >> 9));
  if ((!(t_6 === 0))) {
    let u_3 = (key_4 & 511);
    let X60Qx_139 = nimIcheckB((u_3 >> 5), 15);
    let X60Qx_140 = nimIcheckB((u_3 >> 5), 15);
    mem.setU32(((t_6 + 8) + (X60Qx_139 * 4)), ((mem.u32(((t_6 + 8) + (X60Qx_140 * 4))) & ((~((1 << (u_3 & 31)) >>> 0)) >>> 0)) >>> 0));
  }
}

function isSmallChunk_0_sysvq0asl(c_0) {
  let result_46;
  result_46 = (mem.i32((c_0 + 4)) <= (4056 | 0));
  return result_46;
}

function chunkUnused_0_sysvq0asl(c_1) {
  let result_47;
  result_47 = ((mem.i32(c_1) & 1) === 0);
  return result_47;
}

function pageIndex_0_sysvq0asl(c_2) {
  let result_48;
  result_48 = (c_2 >> 12);
  return result_48;
}

function pageIndex_1_sysvq0asl(p_11) {
  let result_49;
  result_49 = (p_11 >> 12);
  return result_49;
}

function pageAddr_0_sysvq0asl(p_12) {
  let result_50;
  result_50 = (p_12 & (~4095));
  return result_50;
}

function requestOsChunks_0_sysvq0asl(a_20, size_15) {
  let result_51;
  if ((!mem.u8At((a_20 + 6274)))) {
    let usedMem_0 = mem.i32((a_20 + 5236));
    if ((usedMem_0 < Math.imul(64, 1024))) {
      mem.setI32((a_20 + 6276), Math.imul(4096, 4));
    } else {
      let X60Qx_141 = roundup_0_sysvq0asl((usedMem_0 >> 2), 4096);
      let X60Qx_142 = min_2_sysvq0asl(X60Qx_141, Math.imul(mem.i32((a_20 + 6276)), 2));
      mem.setI32((a_20 + 6276), X60Qx_142);
      let X60Qx_143 = min_2_sysvq0asl(mem.i32((a_20 + 6276)), 1056964608);
      mem.setI32((a_20 + 6276), X60Qx_143);
    }
  }
  let size_36 = size_15;
  if ((mem.i32((a_20 + 6276)) < size_36)) {
    let X60Qx_144 = allocPages_0_sysvq0asl(a_20, size_36);
    result_51 = X60Qx_144;
  } else {
    let X60Qx_145 = tryAllocPages_0_sysvq0asl(a_20, mem.i32((a_20 + 6276)));
    result_51 = X60Qx_145;
    if ((result_51 === 0)) {
      let X60Qx_146 = allocPages_0_sysvq0asl(a_20, size_36);
      result_51 = X60Qx_146;
      mem.setU8((a_20 + 6274), true);
    } else {
      size_36 = mem.i32((a_20 + 6276));
    }
  }
  incCurrMem_0_sysvq0asl(a_20, size_36);
  inc_0_Iloplki_party5a2l1((a_20 + 5232), size_36);
  let heapLink_0 = addHeapLink_0_sysvq0asl(a_20, result_51, size_36);
  mem.setU32((result_51 + 12), 0);
  mem.setU32((result_51 + 16), 0);
  mem.setI32((result_51 + 4), size_36);
  let nxt_0 = ((result_51 + size_36) >>> 0);
  let next_1 = nxt_0;
  let X60Qx_147 = pageIndex_0_sysvq0asl(next_1);
  let X60Qx_148 = contains_1_sysvq0asl((a_20 + 5248), X60Qx_147);
  if (X60Qx_148) {
    mem.setI32(next_1, (size_36 | (mem.i32(next_1) & 1)));
  }
  let X60Qx_16;
  if ((!(mem.i32((a_20 + 5240)) === 0))) {
    X60Qx_16 = mem.i32((a_20 + 5240));
  } else {
    X60Qx_16 = 4096;
  }
  let lastSize_0 = X60Qx_16;
  let prv_0 = ((result_51 - lastSize_0) >>> 0);
  let prev_1 = prv_0;
  let X60Qx_149;
  let X60Qx_150 = pageIndex_0_sysvq0asl(prev_1);
  let X60Qx_151 = contains_1_sysvq0asl((a_20 + 5248), X60Qx_150);
  if (X60Qx_151) {
    X60Qx_149 = (mem.i32((prev_1 + 4)) === lastSize_0);
  } else {
    X60Qx_149 = false;
  }
  if (X60Qx_149) {
    mem.setI32(result_51, (lastSize_0 | (mem.i32(result_51) & 1)));
  } else {
    mem.setI32(result_51, (0 | (mem.i32(result_51) & 1)));
  }
  mem.setI32((a_20 + 5240), size_36);
  return result_51;
}

function isAccessible_0_sysvq0asl(a_21, p_13) {
  let result_52;
  let X60Qx_152 = pageIndex_1_sysvq0asl(p_13);
  let X60Qx_153 = contains_1_sysvq0asl((a_21 + 5248), X60Qx_152);
  result_52 = X60Qx_153;
  return result_52;
}

function updatePrevSize_0_sysvq0asl(a_22, c_5, prevSize_0) {
  let ri_0 = ((c_5 + mem.i32((c_5 + 4))) >>> 0);
  let X60Qx_154 = isAccessible_0_sysvq0asl(a_22, ri_0);
  if (X60Qx_154) {
    mem.setI32(ri_0, (prevSize_0 | (mem.i32(ri_0) & 1)));
  }
}

function splitChunk2_0_sysvq0asl(a_23, c_6, size_16) {
  let result_53;
  result_53 = ((c_6 + size_16) >>> 0);
  mem.setI32((result_53 + 4), ((mem.i32((c_6 + 4)) - size_16) | 0));
  mem.setU32((result_53 + 12), 0);
  mem.setU32((result_53 + 16), 0);
  mem.setI32(result_53, size_16);
  mem.setU32((result_53 + 8), a_23);
  updatePrevSize_0_sysvq0asl(a_23, c_6, mem.i32((result_53 + 4)));
  mem.setI32((c_6 + 4), size_16);
  let X60Qx_155 = pageIndex_0_sysvq0asl(result_53);
  incl_2_sysvq0asl(a_23, X60Qx_155);
  return result_53;
}

function splitChunk_0_sysvq0asl(a_24, c_7, size_17) {
  let rest_0 = splitChunk2_0_sysvq0asl(a_24, c_7, size_17);
  addChunkToMatrix_0_sysvq0asl(a_24, rest_0);
}

function freeBigChunk_0_sysvq0asl(a_25, c_8) {
  let c_28 = c_8;
  inc_0_Iloplki_party5a2l1((a_25 + 5232), mem.i32((c_28 + 4)));
  mem.setI32(c_28, (mem.i32(c_28) & (~1)));
  let prevSize_1 = mem.i32(c_28);
  if ((!(prevSize_1 === 0))) {
    let le_0 = ((c_28 - prevSize_1) >>> 0);
    let X60Qx_156;
    let X60Qx_157 = isAccessible_0_sysvq0asl(a_25, le_0);
    if (X60Qx_157) {
      let X60Qx_158 = chunkUnused_0_sysvq0asl(le_0);
      X60Qx_156 = X60Qx_158;
    } else {
      X60Qx_156 = false;
    }
    if (X60Qx_156) {
      let X60Qx_159;
      let X60Qx_160 = isSmallChunk_0_sysvq0asl(le_0);
      if ((!X60Qx_160)) {
        X60Qx_159 = (mem.i32((le_0 + 4)) < 1056964608);
      } else {
        X60Qx_159 = false;
      }
      if (X60Qx_159) {
        removeChunkFromMatrix_0_sysvq0asl(a_25, le_0);
        inc_0_Iloplki_party5a2l1((le_0 + 4), mem.i32((c_28 + 4)));
        let X60Qx_161 = pageIndex_0_sysvq0asl(c_28);
        excl_2_sysvq0asl((a_25 + 5248), X60Qx_161);
        c_28 = le_0;
        if ((1056964608 < mem.i32((c_28 + 4)))) {
          let rest_1 = splitChunk2_0_sysvq0asl(a_25, c_28, 1056964608);
          addChunkToMatrix_0_sysvq0asl(a_25, c_28);
          c_28 = rest_1;
        }
      }
    }
  }
  let ri_1 = ((c_28 + mem.i32((c_28 + 4))) >>> 0);
  let X60Qx_162;
  let X60Qx_163 = isAccessible_0_sysvq0asl(a_25, ri_1);
  if (X60Qx_163) {
    let X60Qx_164 = chunkUnused_0_sysvq0asl(ri_1);
    X60Qx_162 = X60Qx_164;
  } else {
    X60Qx_162 = false;
  }
  if (X60Qx_162) {
    let X60Qx_165;
    let X60Qx_166 = isSmallChunk_0_sysvq0asl(ri_1);
    if ((!X60Qx_166)) {
      X60Qx_165 = (mem.i32((c_28 + 4)) < 1056964608);
    } else {
      X60Qx_165 = false;
    }
    if (X60Qx_165) {
      removeChunkFromMatrix_0_sysvq0asl(a_25, ri_1);
      inc_0_Iloplki_party5a2l1((c_28 + 4), mem.i32((ri_1 + 4)));
      let X60Qx_167 = pageIndex_0_sysvq0asl(ri_1);
      excl_2_sysvq0asl((a_25 + 5248), X60Qx_167);
      if ((1056964608 < mem.i32((c_28 + 4)))) {
        let rest_2 = splitChunk2_0_sysvq0asl(a_25, c_28, 1056964608);
        addChunkToMatrix_0_sysvq0asl(a_25, rest_2);
      }
    }
  }
  addChunkToMatrix_0_sysvq0asl(a_25, c_28);
}

function getBigChunk_0_sysvq0asl(a_26, size_18) {
  let result_54;
  let size_37 = allocFixed(4);
  mem.setI32(size_37, size_18);
  let fl_7 = allocFixed(4);
  mem.setI32(fl_7, 0);
  let sl_8 = allocFixed(4);
  mem.setI32(sl_8, 0);
  mappingSearch_0_sysvq0asl(size_37, fl_7, sl_8);
  let X60Qx_168 = findSuitableBlock_0_sysvq0asl(a_26, fl_7, sl_8);
  result_54 = X60Qx_168;
  if ((result_54 === 0)) {
    if ((mem.i32(size_37) < Math.imul(128, 4096))) {
      let X60Qx_169 = requestOsChunks_0_sysvq0asl(a_26, Math.imul(128, 4096));
      result_54 = X60Qx_169;
      splitChunk_0_sysvq0asl(a_26, result_54, mem.i32(size_37));
    } else {
      let X60Qx_170 = requestOsChunks_0_sysvq0asl(a_26, mem.i32(size_37));
      result_54 = X60Qx_170;
      if ((mem.i32(size_37) < mem.i32((result_54 + 4)))) {
        splitChunk_0_sysvq0asl(a_26, result_54, mem.i32(size_37));
      }
    }
    mem.setU32((result_54 + 8), a_26);
  } else {
    removeChunkFromMatrix2_0_sysvq0asl(a_26, result_54, mem.i32(fl_7), mem.i32(sl_8));
    if ((((mem.i32(size_37) + 4096) | 0) <= mem.i32((result_54 + 4)))) {
      splitChunk_0_sysvq0asl(a_26, result_54, mem.i32(size_37));
    }
  }
  mem.setI32(result_54, 1);
  let X60Qx_171 = pageIndex_0_sysvq0asl(result_54);
  incl_2_sysvq0asl(a_26, X60Qx_171);
  dec_0_Ig5i8xp_ospaexnw61((a_26 + 5232), mem.i32(size_37));
  return result_54;
}

function getHugeChunk_0_sysvq0asl(a_27, size_19) {
  let result_55;
  let X60Qx_172 = allocPages_0_sysvq0asl(a_27, size_19);
  result_55 = X60Qx_172;
  incCurrMem_0_sysvq0asl(a_27, size_19);
  mem.setU32((result_55 + 12), 0);
  mem.setU32((result_55 + 16), 0);
  mem.setI32((result_55 + 4), size_19);
  mem.setI32(result_55, 1);
  mem.setU32((result_55 + 8), a_27);
  let X60Qx_173 = pageIndex_0_sysvq0asl(result_55);
  incl_2_sysvq0asl(a_27, X60Qx_173);
  return result_55;
}

function freeHugeChunk_0_sysvq0asl(a_28, c_9) {
  let size_38 = mem.i32((c_9 + 4));
  let X60Qx_174 = pageIndex_0_sysvq0asl(c_9);
  excl_2_sysvq0asl((a_28 + 5248), X60Qx_174);
  decCurrMem_0_sysvq0asl(a_28, size_38);
  osDeallocPages_0_sysvq0asl(c_9, size_38);
}

function getSmallChunk_0_sysvq0asl(a_29) {
  let result_56;
  let res_1 = getBigChunk_0_sysvq0asl(a_29, 4096);
  result_56 = res_1;
  return result_56;
}

function deallocBigChunk_0_sysvq0asl(a_31, c_10) {
  dec_0_Ig5i8xp_ospaexnw61((a_31 + 5236), mem.i32((c_10 + 4)));
  mem.setU32((c_10 + 16), 0);
  if ((1056964609 <= mem.i32((c_10 + 4)))) {
    freeHugeChunk_0_sysvq0asl(a_31, c_10);
  } else {
    freeBigChunk_0_sysvq0asl(a_31, c_10);
  }
}

function addToSharedFreeListBigChunks_0_sysvq0asl(a_32, c_11) {
  whileStmtLabel_0: {
    {
      while (true) {
        var X60Qx_175 = __atomic_load_n((a_32 + 5244), __ATOMIC_RELAXED);
        __atomic_store_n((c_11 + 12), X60Qx_175, __ATOMIC_RELAXED);
        var X60Qx_176 = __atomic_compare_exchange_n((a_32 + 5244), (c_11 + 12), c_11, true, __ATOMIC_RELEASE, __ATOMIC_RELAXED);
        if (X60Qx_176) {
          break whileStmtLabel_0;
        }
      }
    }
  }
}

function addToSharedFreeList_0_sysvq0asl(c_12, f_0, size_20) {
  whileStmtLabel_0: {
    {
      while (true) {
        var X60Qx_177 = nimIcheckB(size_20, 255);
        var X60Qx_178 = __atomic_load_n(((mem.u32((c_12 + 8)) + 1024) + (X60Qx_177 * 4)), __ATOMIC_RELAXED);
        __atomic_store_n(f_0, X60Qx_178, __ATOMIC_RELAXED);
        var X60Qx_179 = nimIcheckB(size_20, 255);
        var X60Qx_180 = __atomic_compare_exchange_n(((mem.u32((c_12 + 8)) + 1024) + (X60Qx_179 * 4)), f_0, f_0, true, __ATOMIC_RELEASE, __ATOMIC_RELAXED);
        if (X60Qx_180) {
          break whileStmtLabel_0;
        }
      }
    }
  }
}

function compensateCounters_0_sysvq0asl(a_33, c_13, size_21) {
  whileStmtLabel_0: {
    var it_3 = mem.u32((c_13 + 20));
    var total_0 = allocFixed(4);
    mem.setI32(total_0, 0);
    {
      while ((!(it_3 === 0))) {
        inc_0_Iloplki_party5a2l1(total_0, size_21);
        var X60Qx_181 = pageAddr_0_sysvq0asl(it_3);
        var chunk_0 = X60Qx_181;
        if ((!(c_13 === chunk_0))) {
          mem.setI32((c_13 + 32), ((mem.i32((c_13 + 32)) + 1) | 0));
        }
        it_3 = mem.u32(it_3);
      }
    }
  }
  mem.setI32((c_13 + 24), ((mem.i32((c_13 + 24)) + mem.i32(total_0)) | 0));
  dec_0_Ig5i8xp_ospaexnw61((a_33 + 5236), mem.i32(total_0));
}

function freeDeferredObjects_0_sysvq0asl(a_34, root_0) {
  whileStmtLabel_0: {
    var it_4 = root_0;
    var maxIters_0 = allocFixed(4);
    mem.setI32(maxIters_0, 20);
    {
      while (true) {
        var rest_3 = __atomic_load_n((it_4 + 12), __ATOMIC_RELAXED);
        __atomic_store_n((it_4 + 12), 0, __ATOMIC_RELAXED);
        deallocBigChunk_0_sysvq0asl(a_34, it_4);
        if ((mem.i32(maxIters_0) === 0)) {
          if ((!(rest_3 === 0))) {
            addToSharedFreeListBigChunks_0_sysvq0asl(a_34, rest_3);
          }
          break whileStmtLabel_0;
        }
        it_4 = rest_3;
        dec_1_I0nzoz91_envto7w6l1(maxIters_0);
        if ((it_4 === 0)) {
          break whileStmtLabel_0;
        }
      }
    }
  }
}

function smallChunkAlignOffset_0_sysvq0asl(alignment_1) {
  let result_57;
  if ((alignment_1 <= 16)) {
    result_57 = 0;
  } else {
    let X60Qx_182 = align_0_sysvq0asl((48 | 0), alignment_1);
    result_57 = ((((X60Qx_182 - 40) | 0) - 8) | 0);
  }
  return result_57;
}

function bigChunkAlignOffset_0_sysvq0asl(alignment_2) {
  let result_58;
  if ((alignment_2 === 0)) {
    result_58 = 0;
  } else {
    let X60Qx_183 = align_0_sysvq0asl((28 | 0), alignment_2);
    result_58 = ((((X60Qx_183 - 20) | 0) - 8) | 0);
  }
  return result_58;
}

function rawAlloc_0_sysvq0asl(a_35, requestedSize_0, alignment_3) {
  let result_59;
  let X60Qx_184 = max_2_sysvq0asl(16, alignment_3);
  let size_39 = roundup_0_sysvq0asl(requestedSize_0, X60Qx_184);
  let alignOff_0 = smallChunkAlignOffset_0_sysvq0asl(alignment_3);
  if ((((size_39 + alignOff_0) | 0) <= (4056 | 0))) {
    let s_82 = Math.trunc((size_39 / 16));
    let X60Qx_185 = nimIcheckB(s_82, 255);
    let c_29 = mem.u32((a_35 + (X60Qx_185 * 4)));
    let X60Qx_186;
    if ((!(c_29 === 0))) {
      X60Qx_186 = (!(mem.i32((c_29 + 36)) === alignOff_0));
    } else {
      X60Qx_186 = false;
    }
    if (X60Qx_186) {
      c_29 = 0;
    }
    if ((c_29 === 0)) {
      let X60Qx_187 = getSmallChunk_0_sysvq0asl(a_35);
      c_29 = X60Qx_187;
      mem.setU32((c_29 + 20), 0);
      mem.setI32((c_29 + 32), 0);
      mem.setI32((c_29 + 36), alignOff_0);
      mem.setI32((c_29 + 4), size_39);
      mem.setU32((c_29 + 28), ((alignOff_0 + size_39) | 0));
      mem.setI32((c_29 + 24), (((((4056 | 0) - alignOff_0) | 0) - size_39) | 0));
      mem.setU32((c_29 + 12), 0);
      mem.setU32((c_29 + 16), 0);
      if ((mem.u32((c_29 + 20)) === 0)) {
        let X60Qx_188 = nimIcheckB(s_82, 255);
        let X60Qx_189 = __atomic_exchange_n(((a_35 + 1024) + (X60Qx_188 * 4)), 0, __ATOMIC_RELAXED);
        mem.setU32((c_29 + 20), X60Qx_189);
        compensateCounters_0_sysvq0asl(a_35, c_29, size_39);
      }
      if ((size_39 <= mem.i32((c_29 + 24)))) {
        let X60Qx_190 = nimIcheckB(s_82, 255);
        listAdd_0_Ik4wxhz_sysvq0asl((a_35 + (X60Qx_190 * 4)), c_29);
      }
      result_59 = (((c_29 + 40) + alignOff_0) | 0);
    } else {
      if ((mem.u32((c_29 + 20)) === 0)) {
        result_59 = (((c_29 + 40) + mem.u32((c_29 + 28))) >>> 0);
        mem.setU32((c_29 + 28), ((mem.u32((c_29 + 28)) + size_39) >>> 0));
      } else {
        result_59 = mem.u32((c_29 + 20));
        mem.setU32((c_29 + 20), mem.u32(mem.u32((c_29 + 20))));
        let X60Qx_191 = pageAddr_0_sysvq0asl(result_59);
        if ((!(X60Qx_191 === c_29))) {
          mem.setI32((c_29 + 32), ((mem.i32((c_29 + 32)) - 1) | 0));
        } else {
        }
      }
      mem.setI32((c_29 + 24), ((mem.i32((c_29 + 24)) - size_39) | 0));
      if ((mem.u32((c_29 + 20)) === 0)) {
        let X60Qx_192 = nimIcheckB(s_82, 255);
        let X60Qx_193 = __atomic_exchange_n(((a_35 + 1024) + (X60Qx_192 * 4)), 0, __ATOMIC_RELAXED);
        mem.setU32((c_29 + 20), X60Qx_193);
        compensateCounters_0_sysvq0asl(a_35, c_29, size_39);
      }
      if ((mem.i32((c_29 + 24)) < size_39)) {
        let X60Qx_194 = nimIcheckB(s_82, 255);
        listRemove_0_Ibzev091_sysvq0asl((a_35 + (X60Qx_194 * 4)), c_29);
      }
    }
    inc_0_Iloplki_party5a2l1((a_35 + 5236), size_39);
  } else {
    let deferredFrees_0 = __atomic_exchange_n((a_35 + 5244), 0, __ATOMIC_RELAXED);
    if ((!(deferredFrees_0 === 0))) {
      freeDeferredObjects_0_sysvq0asl(a_35, deferredFrees_0);
    }
    let alignPad_0 = bigChunkAlignOffset_0_sysvq0asl(alignment_3);
    size_39 = ((((requestedSize_0 + 20) | 0) + alignPad_0) | 0);
    let X60Qx_17;
    if ((1056964609 <= size_39)) {
      let X60Qx_195 = getHugeChunk_0_sysvq0asl(a_35, size_39);
      X60Qx_17 = X60Qx_195;
    } else {
      let X60Qx_196 = getBigChunk_0_sysvq0asl(a_35, size_39);
      X60Qx_17 = X60Qx_196;
    }
    let c_32 = X60Qx_17;
    result_59 = (((c_32 + 20) + alignPad_0) | 0);
    mem.setU32((c_32 + 16), result_59);
    inc_0_Iloplki_party5a2l1((a_35 + 5236), mem.i32((c_32 + 4)));
  }
  return result_59;
}

function rawDealloc_0_sysvq0asl(a_37, p_14) {
  let c_33 = pageAddr_0_sysvq0asl(p_14);
  let X60Qx_198 = isSmallChunk_0_sysvq0asl(c_33);
  if (X60Qx_198) {
    let c_34 = c_33;
    let s_83 = mem.i32((c_34 + 4));
    let f_3 = p_14;
    if ((mem.u32((c_34 + 8)) === a_37)) {
      dec_0_Ig5i8xp_ospaexnw61((a_37 + 5236), s_83);
      let X60Qx_199 = nimIcheckB(Math.trunc((s_83 / 16)), 255);
      let activeChunk_0 = mem.u32((a_37 + (X60Qx_199 * 4)));
      let X60Qx_200;
      let X60Qx_201;
      if ((!(activeChunk_0 === 0))) {
        X60Qx_201 = (!(c_34 === activeChunk_0));
      } else {
        X60Qx_201 = false;
      }
      if (X60Qx_201) {
        X60Qx_200 = (mem.i32((activeChunk_0 + 36)) === mem.i32((c_34 + 36)));
      } else {
        X60Qx_200 = false;
      }
      if (X60Qx_200) {
        mem.setU32(f_3, mem.u32((activeChunk_0 + 20)));
        mem.setU32((activeChunk_0 + 20), f_3);
        mem.setI32((activeChunk_0 + 24), ((mem.i32((activeChunk_0 + 24)) + s_83) | 0));
        mem.setI32((activeChunk_0 + 32), ((mem.i32((activeChunk_0 + 32)) + 1) | 0));
      } else {
        mem.setU32(f_3, mem.u32((c_34 + 20)));
        mem.setU32((c_34 + 20), f_3);
        if ((mem.i32((c_34 + 24)) < s_83)) {
          let X60Qx_202 = nimIcheckB(Math.trunc((s_83 / 16)), 255);
          listAdd_0_Ik4wxhz_sysvq0asl((a_37 + (X60Qx_202 * 4)), c_34);
          mem.setI32((c_34 + 24), ((mem.i32((c_34 + 24)) + s_83) | 0));
        } else {
          mem.setI32((c_34 + 24), ((mem.i32((c_34 + 24)) + s_83) | 0));
        }
      }
    } else {
      addToSharedFreeList_0_sysvq0asl(c_34, f_3, Math.trunc((s_83 / 16)));
    }
  } else {
    if ((mem.u32((c_33 + 8)) === a_37)) {
      deallocBigChunk_0_sysvq0asl(a_37, c_33);
    } else {
      addToSharedFreeListBigChunks_0_sysvq0asl(mem.u32((c_33 + 8)), c_33);
    }
  }
}

function ptrSize_0_sysvq0asl(p_15) {
  let result_61 = allocFixed(4);
  let c_35 = pageAddr_0_sysvq0asl(p_15);
  mem.setI32(result_61, mem.i32((c_35 + 4)));
  let X60Qx_203 = isSmallChunk_0_sysvq0asl(c_35);
  if ((!X60Qx_203)) {
    dec_0_Ig5i8xp_ospaexnw61(result_61, 20);
  }
  return mem.i32(result_61);
}

function alloc_0_sysvq0asl(allocator_0, size_22) {
  let result_62;
  let X60Qx_204 = rawAlloc_0_sysvq0asl(allocator_0, size_22, 0);
  result_62 = X60Qx_204;
  return result_62;
}

function dealloc_0_sysvq0asl(allocator_2, p_16) {
  rawDealloc_0_sysvq0asl(allocator_2, p_16);
}

function realloc_0_sysvq0asl(allocator_3, p_17, newsize_0) {
  let result_64;
  result_64 = 0;
  if ((0 < newsize_0)) {
    let X60Qx_206 = alloc_0_sysvq0asl(allocator_3, newsize_0);
    result_64 = X60Qx_206;
    if ((!(p_17 === 0))) {
      let X60Qx_207 = ptrSize_0_sysvq0asl(p_17);
      let X60Qx_208 = min_2_sysvq0asl(X60Qx_207, newsize_0);
      copyMem_0_sysvq0asl(result_64, p_17, X60Qx_208);
      dealloc_0_sysvq0asl(allocator_3, p_17);
    }
  } else {
    if ((!(p_17 === 0))) {
      dealloc_0_sysvq0asl(allocator_3, p_17);
    }
  }
  return result_64;
}

let allocator_0_sysvq0asl = allocFixed(6528);

function alloc_1_sysvq0asl(size_24) {
  let result_69;
  let X60Qx_211 = alloc_0_sysvq0asl(allocator_0_sysvq0asl, size_24);
  result_69 = X60Qx_211;
  return result_69;
}

function realloc_1_sysvq0asl(p_19, size_26) {
  let result_71;
  let X60Qx_213 = realloc_0_sysvq0asl(allocator_0_sysvq0asl, p_19, size_26);
  result_71 = X60Qx_213;
  return result_71;
}

function dealloc_1_sysvq0asl(p_20) {
  dealloc_0_sysvq0asl(allocator_0_sysvq0asl, p_20);
}

function allocatedSize_0_sysvq0asl(p_21) {
  let result_72;
  let X60Qx_214 = ptrSize_0_sysvq0asl(p_21);
  result_72 = X60Qx_214;
  return result_72;
}

let missingBytes_0_sysvq0asl = allocFixed(4);

function continueAfterOutOfMem_0_sysvq0asl(size_28) {
  if ((mem.i32(missingBytes_0_sysvq0asl) < ((2147483647 - size_28) | 0))) {
    mem.setI32(missingBytes_0_sysvq0asl, ((mem.i32(missingBytes_0_sysvq0asl) + size_28) | 0));
  } else {
    mem.setI32(missingBytes_0_sysvq0asl, 2147483647);
  }
}

let oomHandler_0_sysvq0asl = allocFixed(4);

mem.setU32(oomHandler_0_sysvq0asl, _fnid(continueAfterOutOfMem_0_sysvq0asl));

function recalcCap_0_sysvq0asl(oldCap_0, addedElements_0) {
  let result_85;
  let X60QconstRefTemp_0;
  X60QconstRefTemp_0 = ((oldCap_0 + addedElements_0) | 0);
  let requiredLen_0 = X60QconstRefTemp_0;
  if (false) {
    result_85 = 2147483647;
  } else {
    let X60QconstRefTemp_1;
    X60QconstRefTemp_1 = ((oldCap_0 + (oldCap_0 >> 1)) | 0);
    result_85 = X60QconstRefTemp_1;
    if (false) {
      result_85 = requiredLen_0;
    } else {
      let X60Qx_219 = max_2_sysvq0asl(result_85, requiredLen_0);
      result_85 = X60Qx_219;
    }
  }
  return result_85;
}

function ssLenOf_0_sysvq0asl(bytes_2) {
  let result_95;
  result_95 = ((bytes_2 & 255) >>> 0);
  return result_95;
}

function rawData_1_sysvq0asl(s_33) {
  let result_96;
  if ((6 < mem.u8At(s_33))) {
    result_96 = (mem.u32((s_33 + 4)) + 12);
  } else {
    result_96 = ((s_33 + 1) >>> 0);
  }
  return result_96;
}

function len_4_sysvq0asl(s_34) {
  let result_98;
  result_98 = mem.u8At(s_34);
  if ((6 < result_98)) {
    result_98 = mem.i32(mem.u32((s_34 + 4)));
  }
  return result_98;
}

function readRawData_0_sysvq0asl(s_39, start_0) {
  let result_103;
  if ((6 < mem.u8At(s_39))) {
    result_103 = (((mem.u32((s_39 + 4)) + 12) + start_0) >>> 0);
  } else {
    result_103 = ((((s_39 + 1) >>> 0) + start_0) >>> 0);
  }
  return result_103;
}

function nimStrWasMoved(s_40) {
  mem.setU32(s_40, 0);
}

function nimStrDestroy(s_41) {
  if ((mem.u8At(s_41) === 255)) {
    let X60Qx_221 = arcDec_0_sysvq0asl((mem.u32((s_41 + 4)) + 4));
    if (X60Qx_221) {
      dealloc_1_sysvq0asl(mem.u32((s_41 + 4)));
    }
  }
}

function nimStrCopy(dest_11, src_6) {
  let ssrc_0 = mem.u8At(src_6);
  if ((ssrc_0 <= 6)) {
    let sdest_0 = mem.u8At(dest_11);
    if ((sdest_0 === 255)) {
      let X60Qx_222 = arcDec_0_sysvq0asl((mem.u32((dest_11 + 4)) + 4));
      if (X60Qx_222) {
        dealloc_1_sysvq0asl(mem.u32((dest_11 + 4)));
      }
    }
    copyMem_0_sysvq0asl(dest_11, src_6, 8);
  } else {
    if ((dest_11 === src_6)) {
      return;
    }
    let sdest_1 = mem.u8At(dest_11);
    if ((sdest_1 === 255)) {
      let X60Qx_223 = arcDec_0_sysvq0asl((mem.u32((dest_11 + 4)) + 4));
      if (X60Qx_223) {
        dealloc_1_sysvq0asl(mem.u32((dest_11 + 4)));
      }
    }
    if ((ssrc_0 === 255)) {
      arcInc_0_sysvq0asl((mem.u32((src_6 + 4)) + 4));
    }
    copyMem_0_sysvq0asl(dest_11, src_6, 8);
  }
}

function nimStrDup(s_42) {
  let result_104 = allocFixed(8);
  let X60Qx_224 = ssLenOf_0_sysvq0asl(mem.u32(s_42));
  if ((X60Qx_224 === 255)) {
    arcInc_0_sysvq0asl((mem.u32((s_42 + 4)) + 4));
  }
  mem.copy(result_104, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, mem.u32(s_42));
    mem.setU32((_o + 4), mem.u32((s_42 + 4)));
    return _o;
  })(), 8);
  return result_104;
}

function len_5_sysvq0asl(a_46) {
  let result_105;
  let X60Qx_19;
  if ((a_46 === 0)) {
    X60Qx_19 = 0;
  } else {
    let X60Qx_225 = strlen(a_46);
    X60Qx_19 = X60Qx_225;
  }
  result_105 = X60Qx_19;
  return result_105;
}

function ssResize_0_sysvq0asl(old_0) {
  let result_106;
  let X60Qx_20;
  if ((old_0 <= 0)) {
    X60Qx_20 = 4;
  } else {
    if ((old_0 <= 32767)) {
      X60Qx_20 = Math.imul(old_0, 2);
    } else {
      X60Qx_20 = ((Math.trunc((old_0 / 2)) + old_0) | 0);
    }
  }
  result_106 = X60Qx_20;
  return result_106;
}

function ensureUniqueLong_0_sysvq0asl(s_43, oldLen_0, newLen_5) {
  let sl_10 = mem.u8At(s_43);
  let isHeap_0 = (sl_10 === 255);
  let X60Qx_21;
  if (isHeap_0) {
    X60Qx_21 = mem.i32((mem.u32((s_43 + 4)) + 8));
  } else {
    X60Qx_21 = 0;
  }
  let cap_1 = X60Qx_21;
  let X60Qx_226;
  let X60Qx_227;
  if (isHeap_0) {
    let X60Qx_228 = arcIsUnique_0_sysvq0asl((mem.u32((s_43 + 4)) + 4));
    X60Qx_227 = X60Qx_228;
  } else {
    X60Qx_227 = false;
  }
  if (X60Qx_227) {
    X60Qx_226 = (newLen_5 <= cap_1);
  } else {
    X60Qx_226 = false;
  }
  if (X60Qx_226) {
    mem.setI32(mem.u32((s_43 + 4)), newLen_5);
    let X60Qx_229 = min_2_sysvq0asl(oldLen_0, 3);
    copyMem_0_sysvq0asl(((s_43 + 1) >>> 0), (mem.u32((s_43 + 4)) + 12), X60Qx_229);
  } else {
    let X60Qx_22;
    if ((cap_1 < newLen_5)) {
      let X60Qx_230 = ssResize_0_sysvq0asl(cap_1);
      let X60Qx_231 = max_2_sysvq0asl(newLen_5, X60Qx_230);
      X60Qx_22 = X60Qx_231;
    } else {
      X60Qx_22 = cap_1;
    }
    let newCap_2 = X60Qx_22;
    let X60Qx_232 = alloc_1_sysvq0asl(((12 + newCap_2) | 0));
    let p_35 = X60Qx_232;
    if ((!(p_35 === 0))) {
      mem.setI32((p_35 + 4), 0);
      mem.setI32(p_35, newLen_5);
      mem.setI32((p_35 + 8), newCap_2);
      if (isHeap_0) {
        let old_2 = mem.u32((s_43 + 4));
        let X60Qx_233 = min_2_sysvq0asl(oldLen_0, newCap_2);
        copyMem_0_sysvq0asl((p_35 + 12), (old_2 + 12), X60Qx_233);
        let X60Qx_234 = arcDec_0_sysvq0asl((old_2 + 4));
        if (X60Qx_234) {
          dealloc_1_sysvq0asl(old_2);
        }
      } else {
        let X60Qx_235 = min_2_sysvq0asl(oldLen_0, newCap_2);
        copyMem_0_sysvq0asl((p_35 + 12), (mem.u32((s_43 + 4)) + 12), X60Qx_235);
      }
      mem.setU32((s_43 + 4), p_35);
      mem.setU8(s_43, (255 & 255));
      let X60Qx_236 = min_2_sysvq0asl(oldLen_0, 3);
      copyMem_0_sysvq0asl(((s_43 + 1) >>> 0), (p_35 + 12), X60Qx_236);
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + newCap_2) | 0));
      mem.setU32(s_43, 21760775509248519n);
      mem.setU32((s_43 + 4), 0);
    }
  }
}

function transitionToLong_0_sysvq0asl(s_44, sl_4, newLen_6) {
  let X60Qx_237 = ssResize_0_sysvq0asl(newLen_6);
  let newCap_3 = max_2_sysvq0asl(newLen_6, X60Qx_237);
  let X60Qx_238 = alloc_1_sysvq0asl(((12 + newCap_3) | 0));
  let p_36 = X60Qx_238;
  if ((!(p_36 === 0))) {
    mem.setI32((p_36 + 4), 0);
    mem.setI32(p_36, newLen_6);
    mem.setI32((p_36 + 8), newCap_3);
    copyMem_0_sysvq0asl((p_36 + 12), ((s_44 + 1) >>> 0), sl_4);
    mem.setU32((s_44 + 4), p_36);
    mem.setU8(s_44, (255 & 255));
    let X60Qx_239 = min_2_sysvq0asl(sl_4, 3);
    copyMem_0_sysvq0asl(((s_44 + 1) >>> 0), (p_36 + 12), X60Qx_239);
  } else {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + newCap_3) | 0));
    mem.setU32(s_44, 21760775509248519n);
    mem.setU32((s_44 + 4), 0);
  }
}

function prepareMutation_0_sysvq0asl(s_46) {
  let sl_12 = mem.u8At(s_46);
  let X60Qx_242;
  if ((sl_12 === 254)) {
    X60Qx_242 = true;
  } else {
    let X60Qx_243;
    if ((sl_12 === 255)) {
      let X60Qx_244 = arcIsUnique_0_sysvq0asl((mem.u32((s_46 + 4)) + 4));
      X60Qx_243 = (!X60Qx_244);
    } else {
      X60Qx_243 = false;
    }
    X60Qx_242 = X60Qx_243;
  }
  if (X60Qx_242) {
    if ((sl_12 === 255)) {
      let X60Qx_245 = arcDec_0_sysvq0asl((mem.u32((s_46 + 4)) + 4));
    }
    let old_3 = mem.u32((s_46 + 4));
    let oldLen_1 = mem.i32(old_3);
    let X60Qx_246 = alloc_1_sysvq0asl(((12 + oldLen_1) | 0));
    let p_37 = X60Qx_246;
    if ((!(p_37 === 0))) {
      mem.setI32((p_37 + 4), 0);
      mem.setI32(p_37, oldLen_1);
      mem.setI32((p_37 + 8), oldLen_1);
      copyMem_0_sysvq0asl((p_37 + 12), (old_3 + 12), oldLen_1);
      mem.setU32((s_46 + 4), p_37);
      mem.setU8(s_46, (255 & 255));
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + oldLen_1) | 0));
      mem.setU32(s_46, 21760775509248519n);
      mem.setU32((s_46 + 4), 0);
    }
  }
}

function add_1_sysvq0asl(s_49, c_14) {
  let sl_14 = mem.u8At(s_49);
  if ((sl_14 < 6)) {
    let newLen_14 = ((sl_14 + 1) | 0);
    mem.setU8((((s_49 + 1) >>> 0) + sl_14), c_14);
    mem.setU8(s_49, (newLen_14 & 255));
  } else {
    if ((6 < sl_14)) {
      let l_1 = mem.i32(mem.u32((s_49 + 4)));
      let X60Qx_248;
      let X60Qx_249;
      if ((sl_14 === 255)) {
        let X60Qx_250 = arcIsUnique_0_sysvq0asl((mem.u32((s_49 + 4)) + 4));
        X60Qx_249 = X60Qx_250;
      } else {
        X60Qx_249 = false;
      }
      if (X60Qx_249) {
        X60Qx_248 = (l_1 < mem.i32((mem.u32((s_49 + 4)) + 8)));
      } else {
        X60Qx_248 = false;
      }
      if (X60Qx_248) {
        mem.setU8(((mem.u32((s_49 + 4)) + 12) + l_1), c_14);
        mem.setI32(mem.u32((s_49 + 4)), ((l_1 + 1) | 0));
        if ((l_1 < 3)) {
          mem.setU8((((s_49 + 1) >>> 0) + l_1), c_14);
        }
      } else {
        let oldLen_2 = mem.i32(mem.u32((s_49 + 4)));
        ensureUniqueLong_0_sysvq0asl(s_49, oldLen_2, ((oldLen_2 + 1) | 0));
        if ((mem.u8At(s_49) === 255)) {
          mem.setU8(((mem.u32((s_49 + 4)) + 12) + oldLen_2), c_14);
          if ((oldLen_2 < 3)) {
            mem.setU8((((s_49 + 1) >>> 0) + oldLen_2), c_14);
          }
        }
      }
    } else {
      transitionToLong_0_sysvq0asl(s_49, sl_14, ((sl_14 + 1) | 0));
      if ((mem.u8At(s_49) === 255)) {
        mem.setU8(((mem.u32((s_49 + 4)) + 12) + sl_14), c_14);
      }
    }
  }
}

function add_2_sysvq0asl(s_50, part_0) {
  let partLen_0 = len_4_sysvq0asl(part_0);
  if ((partLen_0 === 0)) {
    return;
  }
  let partData_0 = rawData_1_sysvq0asl(part_0);
  let sl_15 = mem.u8At(s_50);
  if ((sl_15 <= 6)) {
    let sLen_0 = sl_15;
    let newLen_15 = ((sLen_0 + partLen_0) | 0);
    if ((newLen_15 <= 6)) {
      copyMem_0_sysvq0asl(((((s_50 + 1) >>> 0) + sLen_0) >>> 0), partData_0, partLen_0);
      mem.setU8(s_50, (newLen_15 & 255));
    } else {
      transitionToLong_0_sysvq0asl(s_50, sLen_0, newLen_15);
      if ((mem.u8At(s_50) === 255)) {
        copyMem_0_sysvq0asl((((mem.u32((s_50 + 4)) + 12) + sLen_0) >>> 0), partData_0, partLen_0);
        copyMem_0_sysvq0asl(((s_50 + 1) >>> 0), (mem.u32((s_50 + 4)) + 12), 3);
      }
    }
  } else {
    let sLen_1 = mem.i32(mem.u32((s_50 + 4)));
    let newLen_16 = ((sLen_1 + partLen_0) | 0);
    ensureUniqueLong_0_sysvq0asl(s_50, sLen_1, newLen_16);
    if ((mem.u8At(s_50) === 255)) {
      copyMem_0_sysvq0asl((((mem.u32((s_50 + 4)) + 12) + sLen_1) >>> 0), partData_0, partLen_0);
      if ((sLen_1 < 3)) {
        copyMem_0_sysvq0asl(((s_50 + 1) >>> 0), (mem.u32((s_50 + 4)) + 12), 3);
      }
    }
  }
}

function zeroSwarPadImplLE_0_sysvq0asl(bytes_4, newLen_9) {
  let result_110;
  let keepBits_0 = Math.imul(((newLen_9 + 1) | 0), 8);
  let X60Qx_25;
  if ((Math.imul(4, 8) <= keepBits_0)) {
    X60Qx_25 = ((~0) >>> 0);
  } else {
    X60Qx_25 = ((((1 << keepBits_0) >>> 0) - 1) >>> 0);
  }
  let mask_0 = X60Qx_25;
  result_110 = ((((bytes_4 & ((mask_0 & ((~255) >>> 0)) >>> 0)) >>> 0) | newLen_9) >>> 0);
  return result_110;
}

function zeroSwarPadImpl_0_sysvq0asl(bytes_5, newLen_10) {
  let result_111;
  let X60Qx_251 = zeroSwarPadImplLE_0_sysvq0asl(bytes_5, newLen_10);
  result_111 = X60Qx_251;
  return result_111;
}

function shrink_1_sysvq0asl(s_52, newLen_12) {
  let X60Qx_252 = len_4_sysvq0asl(s_52);
  if ((newLen_12 <= X60Qx_252)) {
    let sl_16 = mem.u8At(s_52);
    if ((sl_16 <= 6)) {
      if ((newLen_12 <= 3)) {
        let X60Qx_253 = zeroSwarPadImpl_0_sysvq0asl(mem.u32(s_52), newLen_12);
        mem.setU32(s_52, X60Qx_253);
      } else {
        mem.setU8(s_52, (newLen_12 & 255));
      }
    } else {
      prepareMutation_0_sysvq0asl(s_52);
      mem.setI32(mem.u32((s_52 + 4)), newLen_12);
      let X60Qx_254 = min_2_sysvq0asl(newLen_12, 3);
      copyMem_0_sysvq0asl(((s_52 + 1) >>> 0), (mem.u32((s_52 + 4)) + 12), X60Qx_254);
    }
  }
}

function setLen_1_sysvq0asl(s_53, newLen_13) {
  let X60Qx_255 = len_4_sysvq0asl(s_53);
  if ((newLen_13 <= X60Qx_255)) {
    shrink_1_sysvq0asl(s_53, newLen_13);
    return;
  }
  let sl_17 = mem.u8At(s_53);
  if ((sl_17 <= 6)) {
    let curLen_1 = len_4_sysvq0asl(s_53);
    if ((newLen_13 <= 6)) {
      let inl_0 = ((s_53 + 1) >>> 0);
      if ((curLen_1 < newLen_13)) {
        zeroMem_0_sysvq0asl(((((s_53 + 1) >>> 0) + curLen_1) >>> 0), ((newLen_13 - curLen_1) | 0));
        mem.setU8(s_53, (newLen_13 & 255));
      } else {
        if ((newLen_13 <= 3)) {
          let X60Qx_256 = zeroSwarPadImpl_0_sysvq0asl(mem.u32(s_53), newLen_13);
          mem.setU32(s_53, X60Qx_256);
        } else {
          mem.setU8(s_53, (newLen_13 & 255));
        }
      }
    } else {
      transitionToLong_0_sysvq0asl(s_53, curLen_1, newLen_13);
      if ((mem.u8At(s_53) === 255)) {
        zeroMem_0_sysvq0asl((((mem.u32((s_53 + 4)) + 12) + curLen_1) >>> 0), ((newLen_13 - curLen_1) | 0));
      }
    }
  } else {
    let curLen_2 = len_4_sysvq0asl(s_53);
    ensureUniqueLong_0_sysvq0asl(s_53, curLen_2, newLen_13);
    if ((mem.u8At(s_53) === 255)) {
      if ((curLen_2 < newLen_13)) {
        zeroMem_0_sysvq0asl((((mem.u32((s_53 + 4)) + 12) + curLen_2) >>> 0), ((newLen_13 - curLen_2) | 0));
      }
      copyMem_0_sysvq0asl(((s_53 + 1) >>> 0), (mem.u32((s_53 + 4)) + 12), 3);
    }
  }
}

function getQ_9_sysvq0asl(s_54, i_14) {
  let X60Qx_257;
  let X60Qx_258 = len_4_sysvq0asl(s_54);
  if ((i_14 < X60Qx_258)) {
    X60Qx_257 = (0 <= i_14);
  } else {
    X60Qx_257 = false;
  }
  if ((!X60Qx_257)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14131790745264837101_sysvq0asl);
      return _o;
    })());
  }
  let result_112;
  let X60Qx_26;
  if ((6 < mem.u8At(s_54))) {
    X60Qx_26 = mem.u8At(((mem.u32((s_54 + 4)) + 12) + i_14));
  } else {
    X60Qx_26 = mem.u8At((((s_54 + 1) >>> 0) + i_14));
  }
  result_112 = X60Qx_26;
  return result_112;
}

function putQ_9_sysvq0asl(s_55, i_15, c_15) {
  let X60Qx_259;
  let X60Qx_260 = len_4_sysvq0asl(s_55);
  if ((i_15 < X60Qx_260)) {
    X60Qx_259 = (0 <= i_15);
  } else {
    X60Qx_259 = false;
  }
  if ((!X60Qx_259)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I11927585966806674622_sysvq0asl);
      return _o;
    })());
  }
  prepareMutation_0_sysvq0asl(s_55);
  if ((6 < mem.u8At(s_55))) {
    mem.setU8(((mem.u32((s_55 + 4)) + 12) + i_15), c_15);
    if ((i_15 < 3)) {
      mem.setU8((((s_55 + 1) >>> 0) + i_15), c_15);
    }
  } else {
    mem.setU8((((s_55 + 1) >>> 0) + i_15), c_15);
  }
}

function substr_0_sysvq0asl(s_56, first_0, last_0) {
  let result_113 = allocFixed(8);
  nimStrWasMoved(result_113);
  nimStrDestroy(result_113);
  mem.copy(result_113, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  let sLen_2 = len_4_sysvq0asl(s_56);
  let f_4 = max_2_sysvq0asl(first_0, 0);
  let X60Qx_261 = min_2_sysvq0asl(last_0, ((sLen_2 - 1) | 0));
  let l_2 = ((X60Qx_261 + 1) | 0);
  if ((l_2 <= f_4)) {
    return result_113;
  }
  let newLen_17 = ((l_2 - f_4) | 0);
  let src_7 = rawData_1_sysvq0asl(s_56);
  if ((newLen_17 <= 6)) {
    mem.setU8(result_113, (newLen_17 & 255));
    copyMem_0_sysvq0asl(((result_113 + 1) >>> 0), ((src_7 + f_4) >>> 0), newLen_17);
  } else {
    let X60Qx_262 = alloc_1_sysvq0asl(((12 + newLen_17) | 0));
    let p_38 = X60Qx_262;
    if ((!(p_38 === 0))) {
      mem.setI32((p_38 + 4), 0);
      mem.setI32(p_38, newLen_17);
      mem.setI32((p_38 + 8), newLen_17);
      copyMem_0_sysvq0asl((p_38 + 12), ((src_7 + f_4) >>> 0), newLen_17);
      mem.setU32((result_113 + 4), p_38);
      mem.setU8(result_113, (255 & 255));
      copyMem_0_sysvq0asl(((result_113 + 1) >>> 0), (p_38 + 12), 3);
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + newLen_17) | 0));
      mem.setU32(result_113, 21760775509248519n);
      mem.setU32((result_113 + 4), 0);
    }
  }
  return result_113;
}

function ctzImpl_0_sysvq0asl(x_313) {
  let result_116;
  let X60Qx_266 = __builtin_ctzll(BigInt(x_313));
  result_116 = X60Qx_266;
  return result_116;
}

function cmpInlineBytes_0_sysvq0asl(a_47, b_10, n_3) {
  forStmtLabel_0: {
    var result_120;
    result_120 = 0;
    {
      whileStmtLabel_1: {
        var X60Qlf_3 = 0;
        var X60Qlf_4 = n_3;
        var X60Qlf_5 = allocFixed(4);
        mem.setI32(X60Qlf_5, X60Qlf_3);
        {
          while ((mem.i32(X60Qlf_5) < X60Qlf_4)) {
            {
              var X60Qii_2 = mem.u8At((a_47 + mem.i32(X60Qlf_5)));
              var X60Qii_3 = mem.u8At((b_10 + mem.i32(X60Qlf_5)));
              if ((X60Qii_2 < X60Qii_3)) {
                return -1;
              }
              if ((X60Qii_3 < X60Qii_2)) {
                return 1;
              }
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_5);
          }
        }
      }
    }
  }
  return result_120;
}

function cmpShortInlineLE_0_sysvq0asl(abytes_1, bbytes_1, aslen_1, bslen_1) {
  let result_122;
  let minLen_1 = min_2_sysvq0asl(aslen_1, bslen_1);
  if ((0 < minLen_1)) {
    let diffMask_0 = ((((1 << Math.imul(minLen_1, 8)) >>> 0) - 1) >>> 0);
    let diff_3 = (((((abytes_1 ^ bbytes_1) >>> 0) >>> 8) & diffMask_0) >>> 0);
    if ((!(diff_3 === 0))) {
      let X60Qx_270 = ctzImpl_0_sysvq0asl(diff_3);
      let byteShift_0 = ((Math.imul((X60Qx_270 >> 3), 8) + 8) | 0);
      let ac_2 = (((abytes_1 >>> byteShift_0) & 255) >>> 0);
      let bc_2 = (((bbytes_1 >>> byteShift_0) & 255) >>> 0);
      if ((ac_2 < bc_2)) {
        return -1;
      }
      return 1;
    }
  }
  result_122 = ((aslen_1 - bslen_1) | 0);
  return result_122;
}

function cmpShortInline_0_sysvq0asl(abytes_2, bbytes_2, aslen_2, bslen_2) {
  let result_123;
  let X60Qx_271 = cmpShortInlineLE_0_sysvq0asl(abytes_2, bbytes_2, aslen_2, bslen_2);
  result_123 = X60Qx_271;
  return result_123;
}

function cmpStringPtrs_0_sysvq0asl(a_48, b_11) {
  let result_124;
  let abytes_3 = mem.u32(a_48);
  let bbytes_3 = mem.u32(b_11);
  let aslen_3 = ssLenOf_0_sysvq0asl(abytes_3);
  let bslen_3 = ssLenOf_0_sysvq0asl(bbytes_3);
  let X60Qx_272;
  if ((aslen_3 <= 3)) {
    X60Qx_272 = (bslen_3 <= 3);
  } else {
    X60Qx_272 = false;
  }
  if (X60Qx_272) {
    let X60Qx_273 = cmpShortInline_0_sysvq0asl(abytes_3, bbytes_3, aslen_3, bslen_3);
    result_124 = X60Qx_273;
    return result_124;
  }
  let X60Qx_274;
  if ((aslen_3 <= 6)) {
    X60Qx_274 = (bslen_3 <= 6);
  } else {
    X60Qx_274 = false;
  }
  if (X60Qx_274) {
    let minLen_2 = min_2_sysvq0asl(aslen_3, bslen_3);
    let pfxLen_0 = min_2_sysvq0asl(minLen_2, 3);
    let X60Qx_275 = cmpInlineBytes_0_sysvq0asl(((a_48 + 1) >>> 0), ((b_11 + 1) >>> 0), pfxLen_0);
    result_124 = X60Qx_275;
    if ((!(result_124 === 0))) {
      return result_124;
    }
    if ((3 < minLen_2)) {
      let X60Qx_276 = cmpInlineBytes_0_sysvq0asl(((((a_48 + 1) >>> 0) + 3) >>> 0), ((((b_11 + 1) >>> 0) + 3) >>> 0), ((minLen_2 - 3) | 0));
      result_124 = X60Qx_276;
    }
    if ((result_124 === 0)) {
      result_124 = ((aslen_3 - bslen_3) | 0);
    }
    return result_124;
  }
  let X60Qx_27;
  if ((6 < aslen_3)) {
    X60Qx_27 = mem.i32(mem.u32((a_48 + 4)));
  } else {
    X60Qx_27 = aslen_3;
  }
  let la_0 = X60Qx_27;
  let X60Qx_28;
  if ((6 < bslen_3)) {
    X60Qx_28 = mem.i32(mem.u32((b_11 + 4)));
  } else {
    X60Qx_28 = bslen_3;
  }
  let lb_0 = X60Qx_28;
  let minLen_3 = min_2_sysvq0asl(la_0, lb_0);
  let pfxLen_1 = min_2_sysvq0asl(minLen_3, 3);
  let X60Qx_277 = cmpInlineBytes_0_sysvq0asl(((a_48 + 1) >>> 0), ((b_11 + 1) >>> 0), pfxLen_1);
  result_124 = X60Qx_277;
  if ((!(result_124 === 0))) {
    return result_124;
  }
  if ((minLen_3 <= 3)) {
    result_124 = ((la_0 - lb_0) | 0);
    return result_124;
  }
  let X60Qx_29;
  if ((6 < aslen_3)) {
    X60Qx_29 = (((mem.u32((a_48 + 4)) + 12) + 3) >>> 0);
  } else {
    X60Qx_29 = ((((a_48 + 1) >>> 0) + 3) >>> 0);
  }
  let ap_0 = X60Qx_29;
  let X60Qx_30;
  if ((6 < bslen_3)) {
    X60Qx_30 = (((mem.u32((b_11 + 4)) + 12) + 3) >>> 0);
  } else {
    X60Qx_30 = ((((b_11 + 1) >>> 0) + 3) >>> 0);
  }
  let bp_0 = X60Qx_30;
  let X60Qx_278 = cmpMem_0_sysvq0asl(ap_0, bp_0, ((minLen_3 - 3) | 0));
  result_124 = X60Qx_278;
  if ((result_124 === 0)) {
    result_124 = ((la_0 - lb_0) | 0);
  }
  return result_124;
}

function equalStrings_0_sysvq0asl(a_49, b_12) {
  let result_125;
  let abytes_4 = mem.u32(a_49);
  let bbytes_4 = mem.u32(b_12);
  let aslen_4 = ssLenOf_0_sysvq0asl(abytes_4);
  let bslen_4 = ssLenOf_0_sysvq0asl(bbytes_4);
  let X60Qx_279;
  if ((aslen_4 <= 3)) {
    X60Qx_279 = (bslen_4 <= 3);
  } else {
    X60Qx_279 = false;
  }
  if (X60Qx_279) {
    result_125 = (abytes_4 === bbytes_4);
    return result_125;
  }
  let X60Qx_31;
  if ((6 < aslen_4)) {
    X60Qx_31 = mem.i32(mem.u32((a_49 + 4)));
  } else {
    X60Qx_31 = aslen_4;
  }
  let la_1 = X60Qx_31;
  let X60Qx_32;
  if ((6 < bslen_4)) {
    X60Qx_32 = mem.i32(mem.u32((b_12 + 4)));
  } else {
    X60Qx_32 = bslen_4;
  }
  let lb_1 = X60Qx_32;
  if ((!(la_1 === lb_1))) {
    return false;
  }
  if ((la_1 === 0)) {
    return true;
  }
  let X60Qx_280;
  if ((aslen_4 <= 6)) {
    X60Qx_280 = (bslen_4 <= 6);
  } else {
    X60Qx_280 = false;
  }
  if (X60Qx_280) {
    if ((!(abytes_4 === bbytes_4))) {
      return false;
    }
    let X60Qx_281 = cmpMem_0_sysvq0asl(((((a_49 + 1) >>> 0) + 3) >>> 0), ((((b_12 + 1) >>> 0) + 3) >>> 0), ((la_1 - 3) | 0));
    result_125 = (X60Qx_281 === 0);
    return result_125;
  }
  let X60Qx_282 = cmpStringPtrs_0_sysvq0asl(a_49, b_12);
  result_125 = (X60Qx_282 === 0);
  return result_125;
}

function eqQ_20_sysvq0asl(a_50, b_13) {
  let result_126;
  let X60Qx_283 = equalStrings_0_sysvq0asl(a_50, b_13);
  result_126 = X60Qx_283;
  return result_126;
}

function nimStrAtLe_0_sysvq0asl(s_58, idx_2, ch_0) {
  let result_127;
  let X60Qx_284;
  let X60Qx_285 = len_4_sysvq0asl(s_58);
  if ((idx_2 < X60Qx_285)) {
    let X60Qx_286 = getQ_9_sysvq0asl(s_58, idx_2);
    X60Qx_284 = (X60Qx_286 <= ch_0);
  } else {
    X60Qx_284 = false;
  }
  result_127 = X60Qx_284;
  return result_127;
}

function newString_0_sysvq0asl(len_4) {
  let result_132 = allocFixed(8);
  nimStrWasMoved(result_132);
  nimStrDestroy(result_132);
  mem.copy(result_132, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  if ((len_4 <= 0)) {
    return result_132;
  }
  if ((len_4 <= 6)) {
    mem.setU8(result_132, (len_4 & 255));
    zeroMem_0_sysvq0asl(((result_132 + 1) >>> 0), len_4);
  } else {
    let X60Qx_294 = alloc_1_sysvq0asl(((12 + len_4) | 0));
    let p_39 = X60Qx_294;
    if ((!(p_39 === 0))) {
      zeroMem_0_sysvq0asl(p_39, ((12 + len_4) | 0));
      mem.setI32((p_39 + 4), 0);
      mem.setI32(p_39, len_4);
      mem.setI32((p_39 + 8), len_4);
      mem.setU32((result_132 + 4), p_39);
      mem.setU8(result_132, (255 & 255));
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + len_4) | 0));
      mem.setU32(result_132, 21760775509248519n);
      mem.setU32((result_132 + 4), 0);
    }
  }
  return result_132;
}

function newStringOfCap_0_sysvq0asl(len_5) {
  let result_133 = allocFixed(8);
  nimStrWasMoved(result_133);
  nimStrDestroy(result_133);
  mem.copy(result_133, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  if ((len_5 <= 6)) {
    return result_133;
  }
  let X60Qx_295 = alloc_1_sysvq0asl(((12 + len_5) | 0));
  let p_40 = X60Qx_295;
  if ((!(p_40 === 0))) {
    zeroMem_0_sysvq0asl(p_40, ((12 + len_5) | 0));
    mem.setI32((p_40 + 4), 0);
    mem.setI32(p_40, 0);
    mem.setI32((p_40 + 8), len_5);
    mem.setU32((result_133 + 4), p_40);
    mem.setU8(result_133, (255 & 255));
  } else {
    _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + len_5) | 0));
    mem.setU32(result_133, 21760775509248519n);
    mem.setU32((result_133 + 4), 0);
  }
  return result_133;
}

function ampQ_0_sysvq0asl(a_54, b_17) {
  let result_134 = allocFixed(8);
  nimStrWasMoved(result_134);
  nimStrDestroy(result_134);
  mem.copy(result_134, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  let X60Qx_296 = len_4_sysvq0asl(a_54);
  let X60Qx_297 = len_4_sysvq0asl(b_17);
  let rlen_0 = ((X60Qx_296 + X60Qx_297) | 0);
  if ((rlen_0 === 0)) {
    return result_134;
  }
  if ((rlen_0 <= 6)) {
    let al_0 = len_4_sysvq0asl(a_54);
    mem.setU8(result_134, (rlen_0 & 255));
    if ((0 < al_0)) {
      let X60Qx_298 = rawData_1_sysvq0asl(a_54);
      copyMem_0_sysvq0asl(((result_134 + 1) >>> 0), X60Qx_298, al_0);
    }
    let X60Qx_299 = len_4_sysvq0asl(b_17);
    if ((0 < X60Qx_299)) {
      let X60Qx_300 = rawData_1_sysvq0asl(b_17);
      let X60Qx_301 = len_4_sysvq0asl(b_17);
      copyMem_0_sysvq0asl(((((result_134 + 1) >>> 0) + al_0) >>> 0), X60Qx_300, X60Qx_301);
    }
  } else {
    let X60Qx_302 = alloc_1_sysvq0asl(((12 + rlen_0) | 0));
    let p_41 = X60Qx_302;
    if ((!(p_41 === 0))) {
      mem.setI32((p_41 + 4), 0);
      mem.setI32(p_41, rlen_0);
      mem.setI32((p_41 + 8), rlen_0);
      let al_1 = len_4_sysvq0asl(a_54);
      if ((0 < al_1)) {
        let X60Qx_303 = rawData_1_sysvq0asl(a_54);
        copyMem_0_sysvq0asl((p_41 + 12), X60Qx_303, al_1);
      }
      let X60Qx_304 = len_4_sysvq0asl(b_17);
      if ((0 < X60Qx_304)) {
        let X60Qx_305 = rawData_1_sysvq0asl(b_17);
        let X60Qx_306 = len_4_sysvq0asl(b_17);
        copyMem_0_sysvq0asl((((p_41 + 12) + al_1) >>> 0), X60Qx_305, X60Qx_306);
      }
      mem.setU32((result_134 + 4), p_41);
      mem.setU8(result_134, (255 & 255));
      copyMem_0_sysvq0asl(((result_134 + 1) >>> 0), (p_41 + 12), 3);
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + rlen_0) | 0));
      mem.setU32(result_134, 21760775509248519n);
      mem.setU32((result_134 + 4), 0);
    }
  }
  return result_134;
}

function borrowCStringUnsafe_0_sysvq0asl(s_61, l_0) {
  let result_139 = allocFixed(8);
  nimStrWasMoved(result_139);
  nimStrDestroy(result_139);
  mem.copy(result_139, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 0);
    mem.setU32((_o + 4), 0);
    return _o;
  })(), 8);
  if ((l_0 <= 0)) {
    return result_139;
  }
  if ((l_0 <= 6)) {
    mem.setU8(result_139, (l_0 & 255));
    copyMem_0_sysvq0asl(((result_139 + 1) >>> 0), s_61, l_0);
  } else {
    let X60Qx_311 = alloc_1_sysvq0asl(((12 + l_0) | 0));
    let p_42 = X60Qx_311;
    if ((!(p_42 === 0))) {
      mem.setI32((p_42 + 4), 0);
      mem.setI32(p_42, l_0);
      mem.setI32((p_42 + 8), l_0);
      copyMem_0_sysvq0asl((p_42 + 12), s_61, l_0);
      mem.setU32((result_139 + 4), p_42);
      mem.setU8(result_139, (255 & 255));
      copyMem_0_sysvq0asl(((result_139 + 1) >>> 0), (p_42 + 12), 3);
    } else {
      _fns[mem.u32(oomHandler_0_sysvq0asl)](((12 + l_0) | 0));
      mem.setU32(result_139, 21760775509248519n);
      mem.setU32((result_139 + 4), 0);
    }
  }
  return result_139;
}

function nimBorrowCStringUnsafe(s_62) {
  let result_140 = allocFixed(8);
  nimStrWasMoved(result_140);
  nimStrDestroy(result_140);
  let X60Qx_312 = len_5_sysvq0asl(s_62);
  let X60Qx_313 = allocFixed(8);
  mem.copy(X60Qx_313, borrowCStringUnsafe_0_sysvq0asl(s_62, X60Qx_312), 8);
  mem.copy(result_140, X60Qx_313, 8);
  return result_140;
}

function ensureTerminatingZero_0_sysvq0asl(s_63) {
  let oldLen_3 = len_4_sysvq0asl(s_63);
  add_1_sysvq0asl(s_63, 0);
  shrink_1_sysvq0asl(s_63, oldLen_3);
}

function toCString_0_sysvq0asl(s_64) {
  let result_141;
  ensureTerminatingZero_0_sysvq0asl(s_64);
  let X60Qx_314 = rawData_1_sysvq0asl(s_64);
  result_141 = X60Qx_314;
  return result_141;
}

function toOpenArray_2_sysvq0asl(s_67) {
  let result_146 = allocFixed(8);
  let X60Qx_316 = readRawData_0_sysvq0asl(s_67, 0);
  let X60Qx_317 = len_4_sysvq0asl(s_67);
  mem.copy(result_146, (() => {
    let _o = allocFixed(8);
    mem.setU32(_o, X60Qx_316);
    mem.setI32((_o + 4), X60Qx_317);
    return _o;
  })(), 8);
  return result_146;
}

function arcInc_0_sysvq0asl(memLoc_0) {
  let X60Qx_318 = __atomic_add_fetch(memLoc_0, 1, __ATOMIC_SEQ_CST);
}

function arcDec_0_sysvq0asl(memLoc_1) {
  let result_156;
  let X60Qx_319 = __atomic_sub_fetch(memLoc_1, 1, __ATOMIC_SEQ_CST);
  result_156 = (X60Qx_319 < 0);
  return result_156;
}

function arcIsUnique_0_sysvq0asl(memLoc_2) {
  let result_157;
  let X60Qx_320 = __atomic_load_n(memLoc_2, __ATOMIC_ACQUIRE);
  result_157 = (X60Qx_320 === 0);
  return result_157;
}

function writeErr_0_sysvq0asl(x_330) {
  fprintf(stderr, "%lld", x_330);
}

function writeErr_1_sysvq0asl(x_331) {
  fprintf(stderr, "%llu", x_331);
}

function writeErr_2_sysvq0asl(s_68) {
  let X60Qx_321 = readRawData_0_sysvq0asl(s_68, 0);
  let X60Qx_322 = len_4_sysvq0asl(s_68);
  let X60Qx_323 = fwrite(X60Qx_321, 1, X60Qx_322, stderr);
}

function writeErr_3_sysvq0asl(s_69) {
  let X60Qx_324 = len_5_sysvq0asl(s_69);
  let X60Qx_325 = fwrite(s_69, 1, X60Qx_324, stderr);
}

function panic_0_sysvq0asl(s_70) {
  writeErr_2_sysvq0asl(s_70);
  exit(1);
}

function nimIcheckAB(i_18, a_68, b_21) {
  let result_158;
  let X60Qx_326;
  if ((a_68 <= i_18)) {
    X60Qx_326 = (i_18 <= b_21);
  } else {
    X60Qx_326 = false;
  }
  if (X60Qx_326) {
    result_158 = ((i_18 - a_68) | 0);
  } else {
    result_158 = 0;
    raiseIndexError3_0_I113jpc1_sysvq0asl(i_18, a_68, b_21);
  }
  return result_158;
}

function nimIcheckB(i_19, b_22) {
  let result_159;
  let X60Qx_327;
  if ((0 <= i_19)) {
    X60Qx_327 = (i_19 <= b_22);
  } else {
    X60Qx_327 = false;
  }
  if (X60Qx_327) {
    result_159 = i_19;
  } else {
    result_159 = 0;
    raiseIndexError3_0_I113jpc1_sysvq0asl(i_19, 0, b_22);
  }
  return result_159;
}

function nimUcheckAB(i_20, a_69, b_23) {
  let result_160;
  result_160 = ((i_20 - a_69) >>> 0);
  if ((b_23 < result_160)) {
    raiseIndexError3_0_Ic5mmkg_sysvq0asl(i_20, a_69, b_23);
  }
  return result_160;
}

function nimUcheckB(i_21, b_24) {
  let result_161;
  result_161 = i_21;
  if ((b_24 < result_161)) {
    raiseIndexError3_0_Ic5mmkg_sysvq0asl(i_21, 0, b_24);
  }
  return result_161;
}

function nimInvalidObjConv(name_0) {
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1986947582);
    mem.setU32((_o + 4), strlit_0_I15539159382304113184_sysvq0asl);
    return _o;
  })());
  writeErr_2_sysvq0asl(name_0);
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2561);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  exit(1);
}

function nimChckNilDisp(p_25) {
  if ((p_25 === 0)) {
    writeErr_2_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1851876350);
      mem.setU32((_o + 4), strlit_0_I14281474217946372742_sysvq0asl);
      return _o;
    })());
    exit(1);
  }
}

function procAddrError_0_sysvq0asl(name_1) {
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1970234366);
    mem.setU32((_o + 4), strlit_0_I10604297744791418982_sysvq0asl);
    return _o;
  })());
  writeErr_3_sysvq0asl(name_1);
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2561);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  exit(1);
}

function nimLoadLibrary(path_2) {
  let result_162;
  let flags_1 = 2;
  let X60Qx_328 = dlopen(path_2, flags_1);
  result_162 = X60Qx_328;
  return result_162;
}

function nimGetProcAddr(lib_3, name_3) {
  let result_163;
  let X60Qx_329 = dlsym(lib_3, name_3);
  result_163 = X60Qx_329;
  if ((result_163 === 0)) {
    procAddrError_0_sysvq0asl(name_3);
  }
  return result_163;
}

function nimDynlibLoadStep(prev_0, cand_0) {
  let result_164;
  if ((!(prev_0 === 0))) {
    result_164 = prev_0;
  } else {
    let X60Qx_330 = nimLoadLibrary(cand_0);
    result_164 = X60Qx_330;
  }
  return result_164;
}

function nimDynlibCheck(lib_4, path_3) {
  let result_165;
  if ((lib_4 === 0)) {
    writeErr_2_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 1970234366);
      mem.setU32((_o + 4), strlit_0_I16690852185662743073_sysvq0asl);
      return _o;
    })());
    writeErr_3_sysvq0asl(path_3);
    writeErr_2_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 2561);
      mem.setU32((_o + 4), 0);
      return _o;
    })());
    exit(1);
  }
  result_165 = lib_4;
  return result_165;
}

function chr_0_sysvq0asl(u_0) {
  let result_168;
  result_168 = (u_0 & 255);
  return result_168;
}

function utoa2Digits_0_sysvq0asl(buf_1, pos_0, digits_0) {
  let X60Qx_332 = nimIcheckB((Math.imul(2, digits_0) >>> 0), 199);
  putQ_10_If2353w_sysvq0asl(buf_1, pos_0, mem.u8At((digits100_0_sysvq0asl + X60Qx_332)));
  let X60Qx_333 = nimIcheckB((((Math.imul(2, digits_0) >>> 0) + 1) >>> 0), 199);
  putQ_10_If2353w_sysvq0asl(buf_1, ((pos_0 + 1) | 0), mem.u8At((digits100_0_sysvq0asl + X60Qx_333)));
}

function trailingZeros2Digits_0_sysvq0asl(digits_1) {
  let result_169;
  let X60Qx_334 = nimIcheckB(digits_1, 99);
  result_169 = mem.i8((trailingZeros100_0_sysvq0asl + X60Qx_334));
  return result_169;
}

function constructDouble_0_sysvq0asl(value_3) {
  let value_3_v = value_3;
  value_3 = allocFixed(8);
  mem.setF64(value_3, value_3_v);
  let result_186 = allocFixed(8);
  let X60Qx_361 = allocFixed(8);
  copyMem_0_sysvq0asl(X60Qx_361, value_3, 8);
  mem.copy(result_186, (() => {
    let _o = allocFixed(8);
    mem.setU64(_o, mem.u64b(X60Qx_361));
    return _o;
  })(), 8);
  return result_186;
}

function physicalSignificand_1_sysvq0asl(this_3) {
  let result_187;
  result_187 = (mem.u64b(this_3) & 4503599627370495n);
  return result_187;
}

function physicalExponent_1_sysvq0asl(this_4) {
  let result_188;
  result_188 = ((mem.u64b(this_4) & 9218868437227405312n) >> BigInt((52 | 0)));
  return result_188;
}

function signBit_1_sysvq0asl(this_5) {
  let result_189;
  result_189 = (!((mem.u64b(this_5) & 9223372036854775808n) === 0n));
  return result_189;
}

function dbFloorDivPow2_0_sysvq0asl(x_342, n_6) {
  let result_190;
  result_190 = (x_342 >> n_6);
  return result_190;
}

function dbFloorLog2Pow10_0_sysvq0asl(e_2) {
  let result_191;
  let X60Qx_362 = dbFloorDivPow2_0_sysvq0asl(Math.imul(e_2, 1741647), 19);
  result_191 = X60Qx_362;
  return result_191;
}

function dbFloorLog10Pow2_0_sysvq0asl(e_3) {
  let result_192;
  let X60Qx_363 = dbFloorDivPow2_0_sysvq0asl(Math.imul(e_3, 1262611), 22);
  result_192 = X60Qx_363;
  return result_192;
}

function dbFloorLog10ThreeQQuartersPow2_0_sysvq0asl(e_4) {
  let result_193;
  let X60Qx_364 = dbFloorDivPow2_0_sysvq0asl(((Math.imul(e_4, 1262611) - 524031) | 0), 22);
  result_193 = X60Qx_364;
  return result_193;
}

function computePow10_0_sysvq0asl(k_1) {
  let result_194 = allocFixed(16);
  let kMin_0 = -292;
  let kMax_0 = 326;
  let pow10_3 = allocFixed(9904);
  mem.copy(pow10_3, (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18408377700990114895n);
    mem.setU64((_o + 8), 2731688931043774331n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 16), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11505236063118821809n);
    mem.setU64((_o + 8), 8624834609543440813n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 32), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14381545078898527261n);
    mem.setU64((_o + 8), 15392729280356688920n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 48), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17976931348623159077n);
    mem.setU64((_o + 8), 5405853545163697438n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 64), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11235582092889474423n);
    mem.setU64((_o + 8), 5684501474941004851n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 80), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14044477616111843029n);
    mem.setU64((_o + 8), 2493940825248868160n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 96), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17555597020139803786n);
    mem.setU64((_o + 8), 7729112049988473104n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 112), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10972248137587377366n);
    mem.setU64((_o + 8), 9442381049670183594n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 128), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13715310171984221708n);
    mem.setU64((_o + 8), 2579604275232953684n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 144), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17144137714980277135n);
    mem.setU64((_o + 8), 3224505344041192105n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 160), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10715086071862673209n);
    mem.setU64((_o + 8), 8932844867666826922n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 176), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13393857589828341511n);
    mem.setU64((_o + 8), 15777742103010921556n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 192), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16742321987285426889n);
    mem.setU64((_o + 8), 15110491610336264041n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 208), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10463951242053391806n);
    mem.setU64((_o + 8), 2526528228819083170n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 224), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13079939052566739757n);
    mem.setU64((_o + 8), 12381532322878629771n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 240), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16349923815708424697n);
    mem.setU64((_o + 8), 1641857348316123501n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 256), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10218702384817765435n);
    mem.setU64((_o + 8), 12555375888766046948n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 272), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12773377981022206794n);
    mem.setU64((_o + 8), 11082533842530170781n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 288), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15966722476277758493n);
    mem.setU64((_o + 8), 4629795266307937668n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 304), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9979201547673599058n);
    mem.setU64((_o + 8), 5199465050656154995n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 320), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12474001934591998822n);
    mem.setU64((_o + 8), 15722703350174969552n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 336), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15592502418239998528n);
    mem.setU64((_o + 8), 10430007150863936131n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 352), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9745314011399999080n);
    mem.setU64((_o + 8), 6518754469289960082n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 368), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12181642514249998850n);
    mem.setU64((_o + 8), 8148443086612450103n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 384), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15227053142812498563n);
    mem.setU64((_o + 8), 962181821410786820n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 400), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9516908214257811601n);
    mem.setU64((_o + 8), 16742264702877599427n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 416), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11896135267822264502n);
    mem.setU64((_o + 8), 7092772823314835571n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 432), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14870169084777830627n);
    mem.setU64((_o + 8), 18089338065998320272n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 448), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9293855677986144142n);
    mem.setU64((_o + 8), 8999993282035256218n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 464), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11617319597482680178n);
    mem.setU64((_o + 8), 2026619565689294465n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 480), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14521649496853350222n);
    mem.setU64((_o + 8), 11756646493966393889n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 496), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18152061871066687778n);
    mem.setU64((_o + 8), 5472436080603216553n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 512), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11345038669416679861n);
    mem.setU64((_o + 8), 8031958568804398250n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 528), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14181298336770849826n);
    mem.setU64((_o + 8), 14651634229432885716n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 544), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17726622920963562283n);
    mem.setU64((_o + 8), 9091170749936331337n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 560), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11079139325602226427n);
    mem.setU64((_o + 8), 3376138709496513134n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 576), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13848924157002783033n);
    mem.setU64((_o + 8), 18055231442152805129n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 592), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17311155196253478792n);
    mem.setU64((_o + 8), 8733981247408842699n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 608), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10819471997658424245n);
    mem.setU64((_o + 8), 5458738279630526687n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 624), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13524339997073030306n);
    mem.setU64((_o + 8), 11435108867965546263n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 640), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16905424996341287883n);
    mem.setU64((_o + 8), 5070514048102157021n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 656), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10565890622713304927n);
    mem.setU64((_o + 8), 863228270850154186n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 672), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13207363278391631158n);
    mem.setU64((_o + 8), 14914093393844856444n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 688), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16509204097989538948n);
    mem.setU64((_o + 8), 9419244705451294747n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 704), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10318252561243461842n);
    mem.setU64((_o + 8), 15110399977761835025n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 720), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12897815701554327303n);
    mem.setU64((_o + 8), 9664627935347517974n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 736), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16122269626942909129n);
    mem.setU64((_o + 8), 7469098900757009563n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 752), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10076418516839318205n);
    mem.setU64((_o + 8), 16197401859041600737n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 768), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12595523146049147757n);
    mem.setU64((_o + 8), 6411694268519837209n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 784), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15744403932561434696n);
    mem.setU64((_o + 8), 12626303854077184415n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 800), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9840252457850896685n);
    mem.setU64((_o + 8), 7891439908798240260n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 816), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12300315572313620856n);
    mem.setU64((_o + 8), 14475985904425188228n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 832), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15375394465392026070n);
    mem.setU64((_o + 8), 18094982380531485285n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 848), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9609621540870016294n);
    mem.setU64((_o + 8), 6697677969404790400n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 864), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12012026926087520367n);
    mem.setU64((_o + 8), 17595469498610763807n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 880), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15015033657609400459n);
    mem.setU64((_o + 8), 17382650854836066855n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 896), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9384396036005875287n);
    mem.setU64((_o + 8), 8558313775058847833n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 912), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11730495045007344109n);
    mem.setU64((_o + 8), 6086206200396171887n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 928), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14663118806259180136n);
    mem.setU64((_o + 8), 12219443768922602762n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 944), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18328898507823975170n);
    mem.setU64((_o + 8), 15274304711153253453n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 960), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11455561567389984481n);
    mem.setU64((_o + 8), 14158126462898171312n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 976), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14319451959237480602n);
    mem.setU64((_o + 8), 3862600023340550428n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 992), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17899314949046850752n);
    mem.setU64((_o + 8), 14051622066030463843n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1008), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11187071843154281720n);
    mem.setU64((_o + 8), 8782263791269039902n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1024), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13983839803942852150n);
    mem.setU64((_o + 8), 10977829739086299877n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1040), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17479799754928565188n);
    mem.setU64((_o + 8), 4498915137003099038n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1056), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10924874846830353242n);
    mem.setU64((_o + 8), 12035193997481712707n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1072), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13656093558537941553n);
    mem.setU64((_o + 8), 5820620459997365076n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1088), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17070116948172426941n);
    mem.setU64((_o + 8), 11887461593424094249n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1104), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10668823092607766838n);
    mem.setU64((_o + 8), 9735506505103752858n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1120), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13336028865759708548n);
    mem.setU64((_o + 8), 2946011094524915264n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1136), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16670036082199635685n);
    mem.setU64((_o + 8), 3682513868156144080n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1152), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10418772551374772303n);
    mem.setU64((_o + 8), 4607414176811284002n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1168), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13023465689218465379n);
    mem.setU64((_o + 8), 1147581702586717098n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1184), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16279332111523081723n);
    mem.setU64((_o + 8), 15269535183515560085n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1200), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10174582569701926077n);
    mem.setU64((_o + 8), 7237616480483531101n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1216), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12718228212127407596n);
    mem.setU64((_o + 8), 13658706619031801780n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1232), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15897785265159259495n);
    mem.setU64((_o + 8), 17073383273789752225n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1248), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9936115790724537184n);
    mem.setU64((_o + 8), 17588393573759676997n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1264), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12420144738405671481n);
    mem.setU64((_o + 8), 3538747893490044630n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1280), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15525180923007089351n);
    mem.setU64((_o + 8), 9035120885289943692n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1296), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9703238076879430844n);
    mem.setU64((_o + 8), 12564479580947296664n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1312), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12129047596099288555n);
    mem.setU64((_o + 8), 15705599476184120829n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1328), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15161309495124110694n);
    mem.setU64((_o + 8), 15020313326802763132n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1344), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9475818434452569184n);
    mem.setU64((_o + 8), 4776009810824339054n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1360), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11844773043065711480n);
    mem.setU64((_o + 8), 5970012263530423817n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1376), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14805966303832139350n);
    mem.setU64((_o + 8), 7462515329413029772n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1392), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9253728939895087094n);
    mem.setU64((_o + 8), 52386062455755703n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1408), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11567161174868858867n);
    mem.setU64((_o + 8), 9288854614924470437n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1424), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14458951468586073584n);
    mem.setU64((_o + 8), 6999382250228200142n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1440), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18073689335732591980n);
    mem.setU64((_o + 8), 8749227812785250178n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1456), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11296055834832869987n);
    mem.setU64((_o + 8), 14691639419845557169n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1472), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14120069793541087484n);
    mem.setU64((_o + 8), 13752863256379558557n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1488), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17650087241926359355n);
    mem.setU64((_o + 8), 17191079070474448197n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1504), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11031304526203974597n);
    mem.setU64((_o + 8), 8438581409832836171n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1520), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13789130657754968246n);
    mem.setU64((_o + 8), 15159912780718433118n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1536), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17236413322193710308n);
    mem.setU64((_o + 8), 9726518939043265589n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1552), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10772758326371068942n);
    mem.setU64((_o + 8), 15302446373756816801n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1568), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13465947907963836178n);
    mem.setU64((_o + 8), 9904685930341245194n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1584), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16832434884954795223n);
    mem.setU64((_o + 8), 3157485376071780684n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1600), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10520271803096747014n);
    mem.setU64((_o + 8), 8890957387685944784n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1616), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13150339753870933768n);
    mem.setU64((_o + 8), 1890324697752655171n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1632), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16437924692338667210n);
    mem.setU64((_o + 8), 2362905872190818964n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1648), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10273702932711667006n);
    mem.setU64((_o + 8), 6088502188546649757n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1664), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12842128665889583757n);
    mem.setU64((_o + 8), 16833999772538088004n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1680), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16052660832361979697n);
    mem.setU64((_o + 8), 7207441660390446293n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1696), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10032913020226237310n);
    mem.setU64((_o + 8), 16033866083812498693n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1712), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12541141275282796638n);
    mem.setU64((_o + 8), 10818960567910847558n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1728), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15676426594103495798n);
    mem.setU64((_o + 8), 4300328673033783640n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1744), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9797766621314684873n);
    mem.setU64((_o + 8), 16522763475928278487n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1760), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12247208276643356092n);
    mem.setU64((_o + 8), 6818396289628184397n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1776), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15309010345804195115n);
    mem.setU64((_o + 8), 8522995362035230496n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1792), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9568131466127621947n);
    mem.setU64((_o + 8), 3021029092058325108n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1808), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11960164332659527433n);
    mem.setU64((_o + 8), 17611344420355070097n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1824), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14950205415824409292n);
    mem.setU64((_o + 8), 8179122470161673909n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1840), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9343878384890255807n);
    mem.setU64((_o + 8), 14335323580705822001n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1856), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11679847981112819759n);
    mem.setU64((_o + 8), 13307468457454889597n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1872), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14599809976391024699n);
    mem.setU64((_o + 8), 12022649553391224093n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1888), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18249762470488780874n);
    mem.setU64((_o + 8), 10416625923311642212n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1904), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11406101544055488046n);
    mem.setU64((_o + 8), 11122077220497164287n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1920), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14257626930069360058n);
    mem.setU64((_o + 8), 4679224488766679550n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1936), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17822033662586700072n);
    mem.setU64((_o + 8), 15072402647813125245n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1952), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11138771039116687545n);
    mem.setU64((_o + 8), 9420251654883203279n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1968), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13923463798895859431n);
    mem.setU64((_o + 8), 16387000587031392002n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 1984), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17404329748619824289n);
    mem.setU64((_o + 8), 15872064715361852098n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2000), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10877706092887390181n);
    mem.setU64((_o + 8), 3002511419460075706n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2016), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13597132616109237726n);
    mem.setU64((_o + 8), 8364825292752482536n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2032), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16996415770136547158n);
    mem.setU64((_o + 8), 1232659579085827362n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2048), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10622759856335341973n);
    mem.setU64((_o + 8), 14605470292210805813n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2064), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13278449820419177467n);
    mem.setU64((_o + 8), 4421779809981343555n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2080), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16598062275523971834n);
    mem.setU64((_o + 8), 915538744049291539n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2096), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10373788922202482396n);
    mem.setU64((_o + 8), 5183897733458195116n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2112), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12967236152753102995n);
    mem.setU64((_o + 8), 6479872166822743895n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2128), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16209045190941378744n);
    mem.setU64((_o + 8), 3488154190101041965n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2144), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10130653244338361715n);
    mem.setU64((_o + 8), 2180096368813151228n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2160), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12663316555422952143n);
    mem.setU64((_o + 8), 16560178516298602747n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2176), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15829145694278690179n);
    mem.setU64((_o + 8), 16088537126945865530n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2192), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9893216058924181362n);
    mem.setU64((_o + 8), 7749492695127472004n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2208), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12366520073655226703n);
    mem.setU64((_o + 8), 463493832054564197n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2224), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15458150092069033378n);
    mem.setU64((_o + 8), 14414425345350368958n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2240), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9661343807543145861n);
    mem.setU64((_o + 8), 13620701859271368503n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2256), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12076679759428932327n);
    mem.setU64((_o + 8), 3190819268807046917n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2272), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15095849699286165408n);
    mem.setU64((_o + 8), 17823582141290972358n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2288), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9434906062053853380n);
    mem.setU64((_o + 8), 11139738838306857724n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2304), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11793632577567316725n);
    mem.setU64((_o + 8), 13924673547883572155n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2320), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14742040721959145907n);
    mem.setU64((_o + 8), 3570783879572301481n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2336), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18427550902448932383n);
    mem.setU64((_o + 8), 18298537904747540563n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2352), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11517219314030582739n);
    mem.setU64((_o + 8), 18354115218108294708n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2368), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14396524142538228424n);
    mem.setU64((_o + 8), 18330958004207980481n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2384), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17995655178172785531n);
    mem.setU64((_o + 8), 4466953431550423985n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2400), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11247284486357990957n);
    mem.setU64((_o + 8), 486002885505321039n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2416), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14059105607947488696n);
    mem.setU64((_o + 8), 5219189625309039203n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2432), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17573882009934360870n);
    mem.setU64((_o + 8), 6523987031636299003n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2448), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10983676256208975543n);
    mem.setU64((_o + 8), 17912549950054850589n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2464), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13729595320261219429n);
    mem.setU64((_o + 8), 17779001419141175332n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2480), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17161994150326524287n);
    mem.setU64((_o + 8), 8388693718644305453n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2496), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10726246343954077679n);
    mem.setU64((_o + 8), 12160462601793772765n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2512), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13407807929942597099n);
    mem.setU64((_o + 8), 10588892233814828052n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2528), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16759759912428246374n);
    mem.setU64((_o + 8), 8624429273841147160n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2544), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10474849945267653984n);
    mem.setU64((_o + 8), 778582277723329071n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2560), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13093562431584567480n);
    mem.setU64((_o + 8), 973227847154161339n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2576), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16366953039480709350n);
    mem.setU64((_o + 8), 1216534808942701674n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2592), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10229345649675443343n);
    mem.setU64((_o + 8), 14595392310871352258n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2608), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12786682062094304179n);
    mem.setU64((_o + 8), 13632554370161802419n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2624), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15983352577617880224n);
    mem.setU64((_o + 8), 12429006944274865119n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2640), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9989595361011175140n);
    mem.setU64((_o + 8), 7768129340171790700n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2656), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12486994201263968925n);
    mem.setU64((_o + 8), 9710161675214738375n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2672), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15608742751579961156n);
    mem.setU64((_o + 8), 16749388112445810872n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2688), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9755464219737475723n);
    mem.setU64((_o + 8), 1244995533423855987n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2704), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12194330274671844653n);
    mem.setU64((_o + 8), 15391302472061983696n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2720), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15242912843339805817n);
    mem.setU64((_o + 8), 5404070034795315908n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2736), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9526820527087378635n);
    mem.setU64((_o + 8), 14906758817815542203n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2752), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11908525658859223294n);
    mem.setU64((_o + 8), 14021762503842039849n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2768), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14885657073574029118n);
    mem.setU64((_o + 8), 8303831092947774003n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2784), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9303535670983768199n);
    mem.setU64((_o + 8), 578208414664970848n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2800), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11629419588729710248n);
    mem.setU64((_o + 8), 14557818573613377272n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2816), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14536774485912137810n);
    mem.setU64((_o + 8), 18197273217016721590n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2832), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18170968107390172263n);
    mem.setU64((_o + 8), 13523219484416126179n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2848), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11356855067118857664n);
    mem.setU64((_o + 8), 15369541205401160718n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2864), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14196068833898572081n);
    mem.setU64((_o + 8), 765182433041899282n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2880), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17745086042373215101n);
    mem.setU64((_o + 8), 5568164059729762006n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2896), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11090678776483259438n);
    mem.setU64((_o + 8), 5785945546544795206n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2912), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13863348470604074297n);
    mem.setU64((_o + 8), 16455803970035769815n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2928), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17329185588255092872n);
    mem.setU64((_o + 8), 6734696907262548557n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2944), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10830740992659433045n);
    mem.setU64((_o + 8), 4209185567039092848n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2960), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13538426240824291306n);
    mem.setU64((_o + 8), 9873167977226253964n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2976), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16923032801030364133n);
    mem.setU64((_o + 8), 3118087934678041647n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 2992), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10576895500643977583n);
    mem.setU64((_o + 8), 4254647968387469982n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3008), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13221119375804971979n);
    mem.setU64((_o + 8), 706623942056949573n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3024), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16526399219756214973n);
    mem.setU64((_o + 8), 14718337982853350678n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3040), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10328999512347634358n);
    mem.setU64((_o + 8), 11504804248497038126n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3056), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12911249390434542948n);
    mem.setU64((_o + 8), 5157633273766521850n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3072), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16139061738043178685n);
    mem.setU64((_o + 8), 6447041592208152312n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3088), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10086913586276986678n);
    mem.setU64((_o + 8), 6335244004343789147n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3104), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12608641982846233347n);
    mem.setU64((_o + 8), 17142427042284512242n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3120), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15760802478557791684n);
    mem.setU64((_o + 8), 16816347784428252398n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3136), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9850501549098619803n);
    mem.setU64((_o + 8), 1286845328412881941n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3152), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12313126936373274753n);
    mem.setU64((_o + 8), 15443614715798266138n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3168), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15391408670466593442n);
    mem.setU64((_o + 8), 5469460339465668960n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3184), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9619630419041620901n);
    mem.setU64((_o + 8), 8030098730593431004n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3200), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12024538023802026126n);
    mem.setU64((_o + 8), 14649309431669176659n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3216), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15030672529752532658n);
    mem.setU64((_o + 8), 9088264752731695016n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3232), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9394170331095332911n);
    mem.setU64((_o + 8), 10291851488884697289n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3248), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11742712913869166139n);
    mem.setU64((_o + 8), 8253128342678483707n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3264), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14678391142336457674n);
    mem.setU64((_o + 8), 5704724409920716730n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3280), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18347988927920572092n);
    mem.setU64((_o + 8), 16354277549255671721n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3296), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11467493079950357558n);
    mem.setU64((_o + 8), 998051431430019018n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3312), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14334366349937946947n);
    mem.setU64((_o + 8), 10470936326142299580n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3328), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17917957937422433684n);
    mem.setU64((_o + 8), 8476984389250486571n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3344), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11198723710889021052n);
    mem.setU64((_o + 8), 14521487280136329915n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3360), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13998404638611276315n);
    mem.setU64((_o + 8), 18151859100170412393n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3376), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17498005798264095394n);
    mem.setU64((_o + 8), 18078137856785627588n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3392), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10936253623915059621n);
    mem.setU64((_o + 8), 15910522178918405147n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3408), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13670317029893824527n);
    mem.setU64((_o + 8), 6053094668365842721n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3424), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17087896287367280659n);
    mem.setU64((_o + 8), 2954682317029915497n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3440), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10679935179604550411n);
    mem.setU64((_o + 8), 17987577512639554850n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3456), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13349918974505688014n);
    mem.setU64((_o + 8), 17872785872372055658n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3472), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16687398718132110018n);
    mem.setU64((_o + 8), 13117610303610293765n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3488), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10429624198832568761n);
    mem.setU64((_o + 8), 12810192458183821507n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3504), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13037030248540710952n);
    mem.setU64((_o + 8), 2177682517447613172n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3520), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16296287810675888690n);
    mem.setU64((_o + 8), 2722103146809516465n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3536), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10185179881672430431n);
    mem.setU64((_o + 8), 6313000485183335695n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3552), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12731474852090538039n);
    mem.setU64((_o + 8), 3279564588051781714n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3568), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15914343565113172548n);
    mem.setU64((_o + 8), 17934513790346890854n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3584), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9946464728195732843n);
    mem.setU64((_o + 8), 1985699082112030976n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3600), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12433080910244666053n);
    mem.setU64((_o + 8), 16317181907922202432n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3616), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15541351137805832567n);
    mem.setU64((_o + 8), 6561419329620589328n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3632), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9713344461128645354n);
    mem.setU64((_o + 8), 11018416108653950186n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3648), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12141680576410806693n);
    mem.setU64((_o + 8), 4549648098962661925n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3664), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15177100720513508366n);
    mem.setU64((_o + 8), 10298746142130715310n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3680), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9485687950320942729n);
    mem.setU64((_o + 8), 1825030320404309165n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3696), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11857109937901178411n);
    mem.setU64((_o + 8), 6892973918932774360n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3712), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14821387422376473014n);
    mem.setU64((_o + 8), 4004531380238580046n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3728), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9263367138985295633n);
    mem.setU64((_o + 8), 16337890167931276241n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3744), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11579208923731619542n);
    mem.setU64((_o + 8), 6587304654631931589n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3760), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14474011154664524427n);
    mem.setU64((_o + 8), 17457502855144690294n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3776), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18092513943330655534n);
    mem.setU64((_o + 8), 17210192550503474963n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3792), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11307821214581659709n);
    mem.setU64((_o + 8), 6144684325637283948n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3808), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14134776518227074636n);
    mem.setU64((_o + 8), 12292541425473992839n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3824), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17668470647783843295n);
    mem.setU64((_o + 8), 15365676781842491049n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3840), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11042794154864902059n);
    mem.setU64((_o + 8), 16521077016292638762n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3856), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13803492693581127574n);
    mem.setU64((_o + 8), 16039660251938410548n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3872), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17254365866976409468n);
    mem.setU64((_o + 8), 10826203278068237377n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3888), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10783978666860255917n);
    mem.setU64((_o + 8), 15989749085647424169n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3904), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13479973333575319897n);
    mem.setU64((_o + 8), 6152128301777116499n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3920), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16849966666969149871n);
    mem.setU64((_o + 8), 12301846395648783527n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3936), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10531229166855718669n);
    mem.setU64((_o + 8), 14606183024921571561n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3952), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13164036458569648337n);
    mem.setU64((_o + 8), 4422670725869800739n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3968), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16455045573212060421n);
    mem.setU64((_o + 8), 10140024425764638827n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 3984), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10284403483257537763n);
    mem.setU64((_o + 8), 8643358275316593219n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4000), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12855504354071922204n);
    mem.setU64((_o + 8), 6192511825718353620n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4016), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16069380442589902755n);
    mem.setU64((_o + 8), 7740639782147942025n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4032), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10043362776618689222n);
    mem.setU64((_o + 8), 2532056854628769814n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4048), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12554203470773361527n);
    mem.setU64((_o + 8), 12388443105140738075n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4064), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15692754338466701909n);
    mem.setU64((_o + 8), 10873867862998534690n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4080), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9807971461541688693n);
    mem.setU64((_o + 8), 9102010423587778133n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4096), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12259964326927110866n);
    mem.setU64((_o + 8), 15989199047912110570n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4112), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15324955408658888583n);
    mem.setU64((_o + 8), 10763126773035362405n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4128), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9578097130411805364n);
    mem.setU64((_o + 8), 13644483260788183359n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4144), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11972621413014756705n);
    mem.setU64((_o + 8), 17055604075985229199n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4160), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14965776766268445882n);
    mem.setU64((_o + 8), 7484447039699372787n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4176), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9353610478917778676n);
    mem.setU64((_o + 8), 9289465418239495896n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4192), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11692013098647223345n);
    mem.setU64((_o + 8), 11611831772799369870n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4208), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14615016373309029182n);
    mem.setU64((_o + 8), 679731660717048625n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4224), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18268770466636286477n);
    mem.setU64((_o + 8), 10073036612751086589n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4240), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11417981541647679048n);
    mem.setU64((_o + 8), 8601490892183123070n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4256), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14272476927059598810n);
    mem.setU64((_o + 8), 10751863615228903838n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4272), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17840596158824498513n);
    mem.setU64((_o + 8), 4216457482181353989n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4288), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11150372599265311570n);
    mem.setU64((_o + 8), 14164500972431816003n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4304), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13937965749081639463n);
    mem.setU64((_o + 8), 8482254178684994196n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4320), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17422457186352049329n);
    mem.setU64((_o + 8), 5991131704928854841n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4336), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10889035741470030830n);
    mem.setU64((_o + 8), 15273672361649004036n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4352), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13611294676837538538n);
    mem.setU64((_o + 8), 9868718415206479237n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4368), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17014118346046923173n);
    mem.setU64((_o + 8), 3112525982153323238n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4384), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10633823966279326983n);
    mem.setU64((_o + 8), 4251171748059520976n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4400), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13292279957849158729n);
    mem.setU64((_o + 8), 702278666647013315n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4416), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16615349947311448411n);
    mem.setU64((_o + 8), 5489534351736154548n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4432), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10384593717069655257n);
    mem.setU64((_o + 8), 1125115960621402641n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4448), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12980742146337069071n);
    mem.setU64((_o + 8), 6018080969204141205n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4464), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16225927682921336339n);
    mem.setU64((_o + 8), 2910915193077788602n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4480), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10141204801825835211n);
    mem.setU64((_o + 8), 17960223060169475540n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4496), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12676506002282294014n);
    mem.setU64((_o + 8), 17838592806784456521n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4512), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15845632502852867518n);
    mem.setU64((_o + 8), 13074868971625794844n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4528), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9903520314283042199n);
    mem.setU64((_o + 8), 3560107088838733873n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4544), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12379400392853802748n);
    mem.setU64((_o + 8), 18285191916330581054n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4560), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15474250491067253436n);
    mem.setU64((_o + 8), 4409745821703674701n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4576), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9671406556917033397n);
    mem.setU64((_o + 8), 11979463175419572496n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4592), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12089258196146291747n);
    mem.setU64((_o + 8), 1139270913992301908n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4608), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15111572745182864683n);
    mem.setU64((_o + 8), 15259146697772541097n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4624), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9444732965739290427n);
    mem.setU64((_o + 8), 7231123676894144234n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4640), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11805916207174113034n);
    mem.setU64((_o + 8), 4427218577690292388n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4656), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14757395258967641292n);
    mem.setU64((_o + 8), 14757395258967641293n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4672), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9223372036854775808n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4688), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11529215046068469760n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4704), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14411518807585587200n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4720), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18014398509481984000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4736), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11258999068426240000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4752), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14073748835532800000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4768), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17592186044416000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4784), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10995116277760000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4800), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13743895347200000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4816), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17179869184000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4832), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10737418240000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4848), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13421772800000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4864), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16777216000000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4880), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10485760000000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4896), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13107200000000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4912), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16384000000000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4928), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10240000000000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4944), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12800000000000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4960), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16000000000000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4976), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10000000000000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 4992), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12500000000000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5008), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15625000000000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5024), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9765625000000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5040), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12207031250000000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5056), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15258789062500000000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5072), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9536743164062500000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5088), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11920928955078125000n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5104), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14901161193847656250n);
    mem.setU64((_o + 8), 0);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5120), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9313225746154785156n);
    mem.setU64((_o + 8), 4611686018427387904n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5136), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11641532182693481445n);
    mem.setU64((_o + 8), 5764607523034234880n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5152), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14551915228366851806n);
    mem.setU64((_o + 8), 11817445422220181504n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5168), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18189894035458564758n);
    mem.setU64((_o + 8), 5548434740920451072n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5184), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11368683772161602973n);
    mem.setU64((_o + 8), 17302829768357445632n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5200), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14210854715202003717n);
    mem.setU64((_o + 8), 7793479155164643328n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5216), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17763568394002504646n);
    mem.setU64((_o + 8), 14353534962383192064n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5232), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11102230246251565404n);
    mem.setU64((_o + 8), 4359273333062107136n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5248), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13877787807814456755n);
    mem.setU64((_o + 8), 5449091666327633920n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5264), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17347234759768070944n);
    mem.setU64((_o + 8), 2199678564482154496n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5280), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10842021724855044340n);
    mem.setU64((_o + 8), 1374799102801346560n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5296), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13552527156068805425n);
    mem.setU64((_o + 8), 1718498878501683200n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5312), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16940658945086006781n);
    mem.setU64((_o + 8), 6759809616554491904n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5328), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10587911840678754238n);
    mem.setU64((_o + 8), 6530724019560251392n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5344), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13234889800848442797n);
    mem.setU64((_o + 8), 17386777061305090048n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5360), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16543612251060553497n);
    mem.setU64((_o + 8), 7898413271349198848n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5376), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10339757656912845935n);
    mem.setU64((_o + 8), 16465723340661719040n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5392), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12924697071141057419n);
    mem.setU64((_o + 8), 15970468157399760896n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5408), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16155871338926321774n);
    mem.setU64((_o + 8), 15351399178322313216n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5424), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10097419586828951109n);
    mem.setU64((_o + 8), 4982938468024057856n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5440), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12621774483536188886n);
    mem.setU64((_o + 8), 10840359103457460224n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5456), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15777218104420236108n);
    mem.setU64((_o + 8), 4327076842467049472n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5472), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9860761315262647567n);
    mem.setU64((_o + 8), 11927795063396681728n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5488), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12325951644078309459n);
    mem.setU64((_o + 8), 10298057810818464256n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5504), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15407439555097886824n);
    mem.setU64((_o + 8), 8260886245095692416n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5520), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9629649721936179265n);
    mem.setU64((_o + 8), 5163053903184807760n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5536), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12037062152420224081n);
    mem.setU64((_o + 8), 11065503397408397604n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5552), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15046327690525280101n);
    mem.setU64((_o + 8), 18443565265187884909n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5568), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9403954806578300063n);
    mem.setU64((_o + 8), 13833071299956122020n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5584), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11754943508222875079n);
    mem.setU64((_o + 8), 12679653106517764621n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5600), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14693679385278593849n);
    mem.setU64((_o + 8), 11237880364719817872n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5616), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18367099231598242312n);
    mem.setU64((_o + 8), 212292400617608628n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5632), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11479437019748901445n);
    mem.setU64((_o + 8), 132682750386005392n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5648), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14349296274686126806n);
    mem.setU64((_o + 8), 4777539456409894645n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5664), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17936620343357658507n);
    mem.setU64((_o + 8), 15195296357367144114n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5680), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11210387714598536567n);
    mem.setU64((_o + 8), 7191217214140771119n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5696), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14012984643248170709n);
    mem.setU64((_o + 8), 4377335499248575995n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5712), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17516230804060213386n);
    mem.setU64((_o + 8), 10083355392488107898n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5728), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10947644252537633366n);
    mem.setU64((_o + 8), 10913783138732455340n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5744), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13684555315672041708n);
    mem.setU64((_o + 8), 4418856886560793367n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5760), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17105694144590052135n);
    mem.setU64((_o + 8), 5523571108200991709n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5776), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10691058840368782584n);
    mem.setU64((_o + 8), 10369760970266701674n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5792), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13363823550460978230n);
    mem.setU64((_o + 8), 12962201212833377092n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5808), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16704779438076222788n);
    mem.setU64((_o + 8), 6979379479186945558n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5824), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10440487148797639242n);
    mem.setU64((_o + 8), 13585484211346616781n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5840), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13050608935997049053n);
    mem.setU64((_o + 8), 7758483227328495169n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5856), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16313261169996311316n);
    mem.setU64((_o + 8), 14309790052588006865n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5872), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10195788231247694572n);
    mem.setU64((_o + 8), 18166990819722280098n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5888), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12744735289059618216n);
    mem.setU64((_o + 8), 4261994450943298507n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5904), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15930919111324522770n);
    mem.setU64((_o + 8), 5327493063679123134n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5920), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9956824444577826731n);
    mem.setU64((_o + 8), 7941369183226839863n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5936), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12446030555722283414n);
    mem.setU64((_o + 8), 5315025460606161924n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5952), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15557538194652854267n);
    mem.setU64((_o + 8), 15867153862612478214n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5968), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9723461371658033917n);
    mem.setU64((_o + 8), 7611128154919104931n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 5984), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12154326714572542396n);
    mem.setU64((_o + 8), 14125596212076269068n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6000), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15192908393215677995n);
    mem.setU64((_o + 8), 17656995265095336336n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6016), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9495567745759798747n);
    mem.setU64((_o + 8), 8729779031470891258n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6032), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11869459682199748434n);
    mem.setU64((_o + 8), 6300537770911226168n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6048), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14836824602749685542n);
    mem.setU64((_o + 8), 17099044250493808518n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6064), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9273015376718553464n);
    mem.setU64((_o + 8), 6075216638131242420n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6080), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11591269220898191830n);
    mem.setU64((_o + 8), 7594020797664053025n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6096), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14489086526122739788n);
    mem.setU64((_o + 8), 269153960225290473n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6112), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18111358157653424735n);
    mem.setU64((_o + 8), 336442450281613091n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6128), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11319598848533390459n);
    mem.setU64((_o + 8), 7127805559067090038n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6144), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14149498560666738074n);
    mem.setU64((_o + 8), 4298070930406474644n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6160), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17686873200833422592n);
    mem.setU64((_o + 8), 14595960699862869113n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6176), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11054295750520889120n);
    mem.setU64((_o + 8), 9122475437414293195n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6192), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13817869688151111400n);
    mem.setU64((_o + 8), 11403094296767866494n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6208), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17272337110188889250n);
    mem.setU64((_o + 8), 14253867870959833118n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6224), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10795210693868055781n);
    mem.setU64((_o + 8), 13520353437777283602n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6240), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13494013367335069727n);
    mem.setU64((_o + 8), 3065383741939440791n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6256), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16867516709168837158n);
    mem.setU64((_o + 8), 17666787732706464701n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6272), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10542197943230523224n);
    mem.setU64((_o + 8), 6430056314514152534n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6288), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13177747429038154030n);
    mem.setU64((_o + 8), 8037570393142690668n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6304), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16472184286297692538n);
    mem.setU64((_o + 8), 823590954573587527n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6320), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10295115178936057836n);
    mem.setU64((_o + 8), 5126430365035880108n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6336), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12868893973670072295n);
    mem.setU64((_o + 8), 6408037956294850135n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6352), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16086117467087590369n);
    mem.setU64((_o + 8), 3398361426941174765n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6368), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10053823416929743980n);
    mem.setU64((_o + 8), 13653190937906703988n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6384), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12567279271162179975n);
    mem.setU64((_o + 8), 17066488672383379985n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6400), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15709099088952724969n);
    mem.setU64((_o + 8), 16721424822051837077n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6416), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9818186930595453106n);
    mem.setU64((_o + 8), 3533361486141316317n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6432), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12272733663244316382n);
    mem.setU64((_o + 8), 13640073894531421205n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6448), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15340917079055395478n);
    mem.setU64((_o + 8), 7826720331309500698n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6464), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9588073174409622174n);
    mem.setU64((_o + 8), 280014188641050032n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6480), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11985091468012027717n);
    mem.setU64((_o + 8), 9573389772656088348n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6496), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14981364335015034646n);
    mem.setU64((_o + 8), 16578423234247498339n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6512), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9363352709384396654n);
    mem.setU64((_o + 8), 5749828502977298558n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6528), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11704190886730495817n);
    mem.setU64((_o + 8), 16410657665576399005n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6544), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14630238608413119772n);
    mem.setU64((_o + 8), 6678264026688335045n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6560), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18287798260516399715n);
    mem.setU64((_o + 8), 8347830033360418806n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6576), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11429873912822749822n);
    mem.setU64((_o + 8), 2911550761636567802n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6592), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14287342391028437277n);
    mem.setU64((_o + 8), 12862810488900485560n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6608), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17859177988785546597n);
    mem.setU64((_o + 8), 2243455055843443238n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6624), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11161986242990966623n);
    mem.setU64((_o + 8), 3708002419115845976n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6640), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13952482803738708279n);
    mem.setU64((_o + 8), 23317005467419566n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6656), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17440603504673385348n);
    mem.setU64((_o + 8), 13864204312116438170n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6672), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10900377190420865842n);
    mem.setU64((_o + 8), 17888499731927549664n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6688), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13625471488026082303n);
    mem.setU64((_o + 8), 13137252628054661272n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6704), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17031839360032602879n);
    mem.setU64((_o + 8), 11809879766640938686n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6720), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10644899600020376799n);
    mem.setU64((_o + 8), 14298703881791668535n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6736), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13306124500025470999n);
    mem.setU64((_o + 8), 13261693833812197764n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6752), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16632655625031838749n);
    mem.setU64((_o + 8), 11965431273837859301n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6768), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10395409765644899218n);
    mem.setU64((_o + 8), 9784237555362356015n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6784), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12994262207056124023n);
    mem.setU64((_o + 8), 3006924907348169211n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6800), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16242827758820155028n);
    mem.setU64((_o + 8), 17593714189467375226n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6816), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10151767349262596893n);
    mem.setU64((_o + 8), 1772699331562333708n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6832), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12689709186578246116n);
    mem.setU64((_o + 8), 6827560182880305039n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6848), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15862136483222807645n);
    mem.setU64((_o + 8), 8534450228600381299n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6864), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9913835302014254778n);
    mem.setU64((_o + 8), 7639874402088932264n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6880), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12392294127517818473n);
    mem.setU64((_o + 8), 326470965756389522n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6896), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15490367659397273091n);
    mem.setU64((_o + 8), 5019774725622874806n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6912), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9681479787123295682n);
    mem.setU64((_o + 8), 831516194300602802n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6928), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12101849733904119602n);
    mem.setU64((_o + 8), 10262767279730529310n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6944), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15127312167380149503n);
    mem.setU64((_o + 8), 3605087062808385830n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6960), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9454570104612593439n);
    mem.setU64((_o + 8), 9170708441896323000n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6976), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11818212630765741799n);
    mem.setU64((_o + 8), 6851699533943015846n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 6992), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14772765788457177249n);
    mem.setU64((_o + 8), 3952938399001381903n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7008), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9232978617785735780n);
    mem.setU64((_o + 8), 13999801545444333449n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7024), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11541223272232169725n);
    mem.setU64((_o + 8), 17499751931805416812n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7040), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14426529090290212157n);
    mem.setU64((_o + 8), 8039631859474607303n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7056), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18033161362862765196n);
    mem.setU64((_o + 8), 14661225842770647033n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7072), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11270725851789228247n);
    mem.setU64((_o + 8), 18386638188586430203n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7088), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14088407314736535309n);
    mem.setU64((_o + 8), 18371611717305649850n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7104), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17610509143420669137n);
    mem.setU64((_o + 8), 9129456591349898601n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7120), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11006568214637918210n);
    mem.setU64((_o + 8), 17235125415662156385n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7136), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13758210268297397763n);
    mem.setU64((_o + 8), 12320534732722919674n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7152), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17197762835371747204n);
    mem.setU64((_o + 8), 10788982397476261688n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7168), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10748601772107342002n);
    mem.setU64((_o + 8), 15966486035277439363n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7184), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13435752215134177503n);
    mem.setU64((_o + 8), 10734735507242023396n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7200), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16794690268917721879n);
    mem.setU64((_o + 8), 8806733365625141341n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7216), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10496681418073576174n);
    mem.setU64((_o + 8), 12421737381156795194n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7232), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13120851772591970218n);
    mem.setU64((_o + 8), 6303799689591218185n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7248), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16401064715739962772n);
    mem.setU64((_o + 8), 17103121648843798539n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7264), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10250665447337476733n);
    mem.setU64((_o + 8), 1466078993672598279n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7280), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12813331809171845916n);
    mem.setU64((_o + 8), 6444284760518135752n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7296), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16016664761464807395n);
    mem.setU64((_o + 8), 8055355950647669691n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7312), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10010415475915504622n);
    mem.setU64((_o + 8), 2728754459941099604n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7328), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12513019344894380777n);
    mem.setU64((_o + 8), 12634315111781150314n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7344), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15641274181117975972n);
    mem.setU64((_o + 8), 1957835834444274180n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7360), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9775796363198734982n);
    mem.setU64((_o + 8), 10447019433382447170n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7376), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12219745453998418728n);
    mem.setU64((_o + 8), 3835402254873283155n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7392), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15274681817498023410n);
    mem.setU64((_o + 8), 4794252818591603944n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7408), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9546676135936264631n);
    mem.setU64((_o + 8), 7608094030047140369n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7424), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11933345169920330789n);
    mem.setU64((_o + 8), 4898431519131537557n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7440), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14916681462400413486n);
    mem.setU64((_o + 8), 10734725417341809851n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7456), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9322925914000258429n);
    mem.setU64((_o + 8), 2097517367411243253n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7472), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11653657392500323036n);
    mem.setU64((_o + 8), 7233582727691441970n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7488), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14567071740625403795n);
    mem.setU64((_o + 8), 9041978409614302462n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7504), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18208839675781754744n);
    mem.setU64((_o + 8), 6690786993590490174n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7520), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11380524797363596715n);
    mem.setU64((_o + 8), 4181741870994056359n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7536), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14225655996704495894n);
    mem.setU64((_o + 8), 615491320315182544n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7552), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17782069995880619867n);
    mem.setU64((_o + 8), 9992736187248753989n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7568), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11113793747425387417n);
    mem.setU64((_o + 8), 3939617107816777291n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7584), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13892242184281734271n);
    mem.setU64((_o + 8), 9536207403198359517n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7600), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17365302730352167839n);
    mem.setU64((_o + 8), 7308573235570561493n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7616), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10853314206470104899n);
    mem.setU64((_o + 8), 11485387299872682789n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7632), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13566642758087631124n);
    mem.setU64((_o + 8), 9745048106413465582n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7648), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16958303447609538905n);
    mem.setU64((_o + 8), 12181310133016831978n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7664), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10598939654755961816n);
    mem.setU64((_o + 8), 695789805494438130n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7680), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13248674568444952270n);
    mem.setU64((_o + 8), 869737256868047663n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7696), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16560843210556190337n);
    mem.setU64((_o + 8), 10310543607939835386n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7712), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10350527006597618960n);
    mem.setU64((_o + 8), 17973304801030866876n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7728), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12938158758247023701n);
    mem.setU64((_o + 8), 4019886927579031980n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7744), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16172698447808779626n);
    mem.setU64((_o + 8), 9636544677901177879n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7760), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10107936529880487266n);
    mem.setU64((_o + 8), 10634526442115624078n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7776), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12634920662350609083n);
    mem.setU64((_o + 8), 4069786015789754290n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7792), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15793650827938261354n);
    mem.setU64((_o + 8), 475546501309804958n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7808), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9871031767461413346n);
    mem.setU64((_o + 8), 4908902581746016003n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7824), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12338789709326766682n);
    mem.setU64((_o + 8), 15359500264037295811n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7840), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15423487136658458353n);
    mem.setU64((_o + 8), 9976003293191843956n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7856), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9639679460411536470n);
    mem.setU64((_o + 8), 17764217104313372233n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7872), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12049599325514420588n);
    mem.setU64((_o + 8), 12981899343536939483n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7888), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15061999156893025735n);
    mem.setU64((_o + 8), 16227374179421174354n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7904), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9413749473058141084n);
    mem.setU64((_o + 8), 17059637889779315827n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7920), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11767186841322676356n);
    mem.setU64((_o + 8), 2877803288514593168n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7936), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14708983551653345445n);
    mem.setU64((_o + 8), 3597254110643241460n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7952), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18386229439566681806n);
    mem.setU64((_o + 8), 9108253656731439729n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7968), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11491393399729176129n);
    mem.setU64((_o + 8), 1080972517029761926n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 7984), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14364241749661470161n);
    mem.setU64((_o + 8), 5962901664714590312n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8000), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17955302187076837701n);
    mem.setU64((_o + 8), 12065313099320625794n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8016), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11222063866923023563n);
    mem.setU64((_o + 8), 9846663696289085073n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8032), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14027579833653779454n);
    mem.setU64((_o + 8), 7696643601933968437n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8048), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17534474792067224318n);
    mem.setU64((_o + 8), 397432465562684739n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8064), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10959046745042015198n);
    mem.setU64((_o + 8), 14083453346258841674n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8080), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13698808431302518998n);
    mem.setU64((_o + 8), 8380944645968776284n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8096), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17123510539128148748n);
    mem.setU64((_o + 8), 1252808770606194547n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8112), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10702194086955092967n);
    mem.setU64((_o + 8), 10006377518483647400n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8128), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13377742608693866209n);
    mem.setU64((_o + 8), 7896285879677171346n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8144), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16722178260867332761n);
    mem.setU64((_o + 8), 14482043368023852087n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8160), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10451361413042082976n);
    mem.setU64((_o + 8), 2133748077373825698n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8176), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13064201766302603720n);
    mem.setU64((_o + 8), 2667185096717282123n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8192), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16330252207878254650n);
    mem.setU64((_o + 8), 3333981370896602653n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8208), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10206407629923909156n);
    mem.setU64((_o + 8), 6695424375237764562n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8224), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12758009537404886445n);
    mem.setU64((_o + 8), 8369280469047205703n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8240), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15947511921756108056n);
    mem.setU64((_o + 8), 15073286604736395033n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8256), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9967194951097567535n);
    mem.setU64((_o + 8), 9420804127960246895n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8272), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12458993688871959419n);
    mem.setU64((_o + 8), 7164319141522920715n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8288), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15573742111089949274n);
    mem.setU64((_o + 8), 4343712908476262990n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8304), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9733588819431218296n);
    mem.setU64((_o + 8), 7326506586225052273n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8320), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12166986024289022870n);
    mem.setU64((_o + 8), 9158133232781315341n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8336), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15208732530361278588n);
    mem.setU64((_o + 8), 2224294504121868368n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8352), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9505457831475799117n);
    mem.setU64((_o + 8), 10613556101930943538n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8368), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11881822289344748896n);
    mem.setU64((_o + 8), 17878631145841067327n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8384), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14852277861680936121n);
    mem.setU64((_o + 8), 3901544858591782542n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8400), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9282673663550585075n);
    mem.setU64((_o + 8), 13967680582688333849n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8416), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11603342079438231344n);
    mem.setU64((_o + 8), 12847914709933029407n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8432), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14504177599297789180n);
    mem.setU64((_o + 8), 16059893387416286759n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8448), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18130221999122236476n);
    mem.setU64((_o + 8), 1628122660560806833n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8464), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11331388749451397797n);
    mem.setU64((_o + 8), 10240948699705280078n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8480), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14164235936814247246n);
    mem.setU64((_o + 8), 17412871893058988002n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8496), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17705294921017809058n);
    mem.setU64((_o + 8), 12542717829468959195n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8512), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11065809325636130661n);
    mem.setU64((_o + 8), 12450884661845487401n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8528), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13832261657045163327n);
    mem.setU64((_o + 8), 1728547772024695539n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8544), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17290327071306454158n);
    mem.setU64((_o + 8), 15995742770313033136n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8560), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10806454419566533849n);
    mem.setU64((_o + 8), 5385653213018257806n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8576), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13508068024458167311n);
    mem.setU64((_o + 8), 11343752534700210161n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8592), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16885085030572709139n);
    mem.setU64((_o + 8), 9568004649947874797n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8608), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10553178144107943212n);
    mem.setU64((_o + 8), 3674159897003727796n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8624), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13191472680134929015n);
    mem.setU64((_o + 8), 4592699871254659745n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8640), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16489340850168661269n);
    mem.setU64((_o + 8), 1129188820640936778n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8656), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10305838031355413293n);
    mem.setU64((_o + 8), 3011586022114279438n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8672), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12882297539194266616n);
    mem.setU64((_o + 8), 8376168546070237202n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8688), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16102871923992833270n);
    mem.setU64((_o + 8), 10470210682587796502n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8704), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10064294952495520794n);
    mem.setU64((_o + 8), 1932195658189984910n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8720), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12580368690619400992n);
    mem.setU64((_o + 8), 11638616609592256945n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8736), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15725460863274251240n);
    mem.setU64((_o + 8), 14548270761990321182n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8752), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9828413039546407025n);
    mem.setU64((_o + 8), 9092669226243950738n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8768), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12285516299433008781n);
    mem.setU64((_o + 8), 15977522551232326327n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8784), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15356895374291260977n);
    mem.setU64((_o + 8), 6136845133758244197n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8800), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9598059608932038110n);
    mem.setU64((_o + 8), 15364743254667372383n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8816), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11997574511165047638n);
    mem.setU64((_o + 8), 9982557031479439671n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8832), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14996968138956309548n);
    mem.setU64((_o + 8), 3254824252494523781n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8848), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9373105086847693467n);
    mem.setU64((_o + 8), 11257637194663853171n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8864), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11716381358559616834n);
    mem.setU64((_o + 8), 9460360474902428559n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8880), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14645476698199521043n);
    mem.setU64((_o + 8), 2602078556773259891n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8896), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18306845872749401303n);
    mem.setU64((_o + 8), 17087656251248738576n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8912), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11441778670468375814n);
    mem.setU64((_o + 8), 17597314184671543466n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8928), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14302223338085469768n);
    mem.setU64((_o + 8), 12773270693984653525n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8944), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17877779172606837210n);
    mem.setU64((_o + 8), 15966588367480816906n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8960), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11173611982879273256n);
    mem.setU64((_o + 8), 14590803748102898470n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8976), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13967014978599091570n);
    mem.setU64((_o + 8), 18238504685128623088n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 8992), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17458768723248864463n);
    mem.setU64((_o + 8), 13574758819556003052n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9008), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10911730452030540289n);
    mem.setU64((_o + 8), 15401753289863583763n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9024), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13639663065038175362n);
    mem.setU64((_o + 8), 5417133557047315992n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9040), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17049578831297719202n);
    mem.setU64((_o + 8), 15994788983163920798n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9056), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10655986769561074501n);
    mem.setU64((_o + 8), 14608429132904838403n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9072), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13319983461951343127n);
    mem.setU64((_o + 8), 4425478360848884291n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9088), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16649979327439178909n);
    mem.setU64((_o + 8), 920161932633717460n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9104), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10406237079649486818n);
    mem.setU64((_o + 8), 2880944217109767365n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9120), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13007796349561858522n);
    mem.setU64((_o + 8), 12824552308241985014n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9136), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16259745436952323153n);
    mem.setU64((_o + 8), 6807318348447705459n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9152), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10162340898095201970n);
    mem.setU64((_o + 8), 15783789013848285672n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9168), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12702926122619002463n);
    mem.setU64((_o + 8), 10506364230455581282n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9184), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15878657653273753079n);
    mem.setU64((_o + 8), 8521269269642088699n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9200), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9924161033296095674n);
    mem.setU64((_o + 8), 12243322321167387293n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9216), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12405201291620119593n);
    mem.setU64((_o + 8), 6080780864604458308n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9232), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15506501614525149491n);
    mem.setU64((_o + 8), 12212662099182960789n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9248), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9691563509078218432n);
    mem.setU64((_o + 8), 5327070802775656541n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9264), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12114454386347773040n);
    mem.setU64((_o + 8), 6658838503469570676n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9280), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15143067982934716300n);
    mem.setU64((_o + 8), 8323548129336963345n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9296), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9464417489334197687n);
    mem.setU64((_o + 8), 14425589617690377899n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9312), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11830521861667747109n);
    mem.setU64((_o + 8), 13420301003685584469n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9328), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14788152327084683887n);
    mem.setU64((_o + 8), 2940318199324816875n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9344), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9242595204427927429n);
    mem.setU64((_o + 8), 8755227902219092403n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9360), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11553244005534909286n);
    mem.setU64((_o + 8), 15555720896201253407n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9376), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14441555006918636608n);
    mem.setU64((_o + 8), 10221279083396790951n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9392), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18051943758648295760n);
    mem.setU64((_o + 8), 12776598854245988689n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9408), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11282464849155184850n);
    mem.setU64((_o + 8), 7985374283903742931n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9424), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14103081061443981063n);
    mem.setU64((_o + 8), 758345818024902856n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9440), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17628851326804976328n);
    mem.setU64((_o + 8), 14782990327813292282n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9456), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11018032079253110205n);
    mem.setU64((_o + 8), 9239368954883307676n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9472), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13772540099066387756n);
    mem.setU64((_o + 8), 16160897212031522499n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9488), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17215675123832984696n);
    mem.setU64((_o + 8), 1754377441329851508n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9504), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10759796952395615435n);
    mem.setU64((_o + 8), 1096485900831157192n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9520), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13449746190494519293n);
    mem.setU64((_o + 8), 15205665431321110202n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9536), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16812182738118149117n);
    mem.setU64((_o + 8), 5172023733869224041n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9552), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10507614211323843198n);
    mem.setU64((_o + 8), 5538357842881958977n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9568), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13134517764154803997n);
    mem.setU64((_o + 8), 16146319340457224530n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9584), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16418147205193504997n);
    mem.setU64((_o + 8), 6347841120289366950n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9600), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10261342003245940623n);
    mem.setU64((_o + 8), 6273243709394548296n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9616), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12826677504057425779n);
    mem.setU64((_o + 8), 3229868618315797466n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9632), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16033346880071782223n);
    mem.setU64((_o + 8), 17872393828176910545n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9648), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10020841800044863889n);
    mem.setU64((_o + 8), 18087775170251650946n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9664), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12526052250056079862n);
    mem.setU64((_o + 8), 8774660907532399971n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9680), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15657565312570099828n);
    mem.setU64((_o + 8), 1744954097560724156n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9696), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9785978320356312392n);
    mem.setU64((_o + 8), 10313968347830228405n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9712), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 12232472900445390490n);
    mem.setU64((_o + 8), 12892460434787785506n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9728), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15290591125556738113n);
    mem.setU64((_o + 8), 6892203506629956075n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9744), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9556619453472961320n);
    mem.setU64((_o + 8), 15836842237712192307n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9760), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11945774316841201651n);
    mem.setU64((_o + 8), 1349308723430688768n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9776), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14932217896051502063n);
    mem.setU64((_o + 8), 15521693959570524672n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9792), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 9332636185032188789n);
    mem.setU64((_o + 8), 16618587752372659776n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9808), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11665795231290235987n);
    mem.setU64((_o + 8), 6938176635183661008n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9824), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14582244039112794984n);
    mem.setU64((_o + 8), 4061034775552188356n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9840), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 18227805048890993730n);
    mem.setU64((_o + 8), 5076293469440235445n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9856), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11392378155556871081n);
    mem.setU64((_o + 8), 7784369436827535057n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9872), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14240472694446088851n);
    mem.setU64((_o + 8), 14342147814461806725n);
    return _o;
  })(), 16);
  mem.copy((pow10_3 + 9888), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 17800590868057611064n);
    mem.setU64((_o + 8), 13315998749649870503n);
    return _o;
  })(), 16);
  let X60Qx_365 = nimIcheckB(((k_1 - -292) | 0), 618);
  mem.copy(result_194, (pow10_3 + (X60Qx_365 * 16)), 16);
  return result_194;
}

function multipleOfPow2_1_sysvq0asl(value_4, e2_1) {
  let result_195;
  let X60Qx_366;
  if ((e2_1 < 64)) {
    X60Qx_366 = ((value_4 & BigInt.asUintN(64, (BigInt.asUintN(64, (1n << BigInt(e2_1))) - 1n))) === 0n);
  } else {
    X60Qx_366 = false;
  }
  result_195 = X60Qx_366;
  return result_195;
}

function multipleOfPow5_0_sysvq0asl(value_5, e5_0) {
  let result_196;
  let mod5_0 = allocFixed(400);
  mem.copy(mod5_0, (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 1);
    mem.setU64((_o + 8), 18446744073709551615n);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 16), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14757395258967641293n);
    mem.setU64((_o + 8), 3689348814741910323n);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 32), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10330176681277348905n);
    mem.setU64((_o + 8), 737869762948382064n);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 48), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 2066035336255469781n);
    mem.setU64((_o + 8), 147573952589676412n);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 64), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15170602326218735249n);
    mem.setU64((_o + 8), 29514790517935282n);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 80), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 6723469279985657373n);
    mem.setU64((_o + 8), 5902958103587056);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 96), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 8723391485480952121n);
    mem.setU64((_o + 8), 1180591620717411);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 112), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16502073556063831717n);
    mem.setU64((_o + 8), 236118324143482);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 128), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14368461155438497313n);
    mem.setU64((_o + 8), 47223664828696);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 144), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10252389860571520109n);
    mem.setU64((_o + 8), 9444732965739);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 160), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 5739826786856214345n);
    mem.setU64((_o + 8), 1888946593147);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 176), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 1147965357371242869n);
    mem.setU64((_o + 8), 377789318629);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 192), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 3918941886216158897n);
    mem.setU64((_o + 8), 75557863725);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 208), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 11851834821468962749n);
    mem.setU64((_o + 8), 15111572745);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 224), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 6059715779035702873n);
    mem.setU64((_o + 8), 3022314549);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 240), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 8590640785290961221n);
    mem.setU64((_o + 8), 604462909);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 256), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 16475523416025833537n);
    mem.setU64((_o + 8), 120892581);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 272), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 14363151127430897677n);
    mem.setU64((_o + 8), 24178516);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 288), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 13940676669711910505n);
    mem.setU64((_o + 8), 4835703);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 304), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 2788135333942382101n);
    mem.setU64((_o + 8), 967140);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 320), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15315022325756117713n);
    mem.setU64((_o + 8), 193428);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 336), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 10441702094635044189n);
    mem.setU64((_o + 8), 38685);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 352), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 5777689233668919161n);
    mem.setU64((_o + 8), 7737);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 368), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 15912933105701425125n);
    mem.setU64((_o + 8), 1547);
    return _o;
  })(), 16);
  mem.copy((mod5_0 + 384), (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, 3182586621140285025n);
    mem.setU64((_o + 8), 309);
    return _o;
  })(), 16);
  let X60Qx_367 = nimIcheckB(e5_0, 24);
  let m5_0 = allocFixed(16);
  mem.copy(m5_0, (mod5_0 + (X60Qx_367 * 16)), 16);
  result_196 = (BigInt.asUintN(64, (value_5 * mem.u64b(m5_0))) <= mem.u64b((m5_0 + 8)));
  return result_196;
}

function toDecimal64AsymmetricInterval_0_sysvq0asl(e2_2) {
  let result_197 = allocFixed(16);
  let P_0 = 53;
  let minusK_2 = dbFloorLog10ThreeQQuartersPow2_0_sysvq0asl(e2_2);
  let X60Qx_368 = dbFloorLog2Pow10_0_sysvq0asl((-minusK_2));
  let betaMinus1_2 = ((e2_2 + X60Qx_368) | 0);
  let pow10_4 = allocFixed(16);
  mem.copy(pow10_4, computePow10_0_sysvq0asl((-minusK_2)), 16);
  let lowerEndpoint_0 = (BigInt.asUintN(64, (mem.u64b(pow10_4) - (mem.u64b(pow10_4) >> BigInt((54 | 0))))) >> BigInt((((11 | 0) - betaMinus1_2) | 0)));
  let upperEndpoint_0 = (BigInt.asUintN(64, (mem.u64b(pow10_4) + (mem.u64b(pow10_4) >> BigInt((53 | 0))))) >> BigInt((((11 | 0) - betaMinus1_2) | 0)));
  let X60Qx_369;
  if ((2 <= e2_2)) {
    X60Qx_369 = (e2_2 <= 3);
  } else {
    X60Qx_369 = false;
  }
  let lowerEndpointIsInteger_0 = X60Qx_369;
  let xi_0 = BigInt.asUintN(64, (lowerEndpoint_0 + BigInt((!lowerEndpointIsInteger_0))));
  let zi_0 = upperEndpoint_0;
  let q_5 = allocFixed(8);
  mem.setU64(q_5, (zi_0 / 10n));
  if ((xi_0 <= BigInt.asUintN(64, (mem.u64b(q_5) * 10n)))) {
    mem.copy(result_197, (() => {
      let _o = allocFixed(16);
      mem.setU64(_o, mem.u64b(q_5));
      mem.setI32((_o + 8), ((minusK_2 + 1) | 0));
      return _o;
    })(), 16);
    return result_197;
  }
  mem.setU64(q_5, (BigInt.asUintN(64, ((mem.u64b(pow10_4) >> BigInt(((((64 - (54 | 0)) | 0) - betaMinus1_2) | 0))) + 1n)) / 2n));
  if ((e2_2 === -77)) {
    dec_0_Idgnuqw1_sysvq0asl(q_5, BigInt((!((mem.u64b(q_5) % 2n) === 0n))));
  } else {
    inc_0_Ineawm41_party5a2l1(q_5, BigInt((mem.u64b(q_5) < xi_0)));
  }
  mem.copy(result_197, (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, mem.u64b(q_5));
    mem.setI32((_o + 8), minusK_2);
    return _o;
  })(), 16);
  return result_197;
}

function computeDelta_0_sysvq0asl(pow10_0, betaMinus1_0) {
  let result_198;
  result_198 = Number(BigInt.asUintN(32, (mem.u64b(pow10_0) >> BigInt((((63 | 0) - betaMinus1_0) | 0)))));
  return result_198;
}

function dbLo32_0_sysvq0asl(x_343) {
  let result_199;
  result_199 = Number(BigInt.asUintN(32, x_343));
  return result_199;
}

function dbHi32_0_sysvq0asl(x_344) {
  let result_200;
  result_200 = Number(BigInt.asUintN(32, (x_344 >> 32n)));
  return result_200;
}

function mul128_0_sysvq0asl(a_70, b_25) {
  let result_201 = allocFixed(16);
  let X60Qx_370 = dbLo32_0_sysvq0asl(a_70);
  let X60Qx_371 = dbLo32_0_sysvq0asl(b_25);
  let b00_0 = BigInt.asUintN(64, (BigInt(X60Qx_370) * BigInt(X60Qx_371)));
  let X60Qx_372 = dbLo32_0_sysvq0asl(a_70);
  let X60Qx_373 = dbHi32_0_sysvq0asl(b_25);
  let b01_1 = BigInt.asUintN(64, (BigInt(X60Qx_372) * BigInt(X60Qx_373)));
  let X60Qx_374 = dbHi32_0_sysvq0asl(a_70);
  let X60Qx_375 = dbLo32_0_sysvq0asl(b_25);
  let b10_0 = BigInt.asUintN(64, (BigInt(X60Qx_374) * BigInt(X60Qx_375)));
  let X60Qx_376 = dbHi32_0_sysvq0asl(a_70);
  let X60Qx_377 = dbHi32_0_sysvq0asl(b_25);
  let b11_1 = BigInt.asUintN(64, (BigInt(X60Qx_376) * BigInt(X60Qx_377)));
  let X60Qx_378 = dbHi32_0_sysvq0asl(b00_0);
  let mid1_0 = BigInt.asUintN(64, (b10_0 + BigInt(X60Qx_378)));
  let X60Qx_379 = dbLo32_0_sysvq0asl(mid1_0);
  let mid2_0 = BigInt.asUintN(64, (b01_1 + BigInt(X60Qx_379)));
  let X60Qx_380 = dbHi32_0_sysvq0asl(mid1_0);
  let X60Qx_381 = dbHi32_0_sysvq0asl(mid2_0);
  let hi_1 = BigInt.asUintN(64, (BigInt.asUintN(64, (b11_1 + BigInt(X60Qx_380))) + BigInt(X60Qx_381)));
  let X60Qx_382 = dbLo32_0_sysvq0asl(b00_0);
  let X60Qx_383 = dbLo32_0_sysvq0asl(mid2_0);
  let lo_0 = (BigInt(X60Qx_382) | BigInt.asUintN(64, (BigInt(X60Qx_383) << 32n)));
  mem.copy(result_201, (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, hi_1);
    mem.setU64((_o + 8), lo_0);
    return _o;
  })(), 16);
  return result_201;
}

function mulShift_0_sysvq0asl(x_345, y_205) {
  let result_202;
  let p1_0 = allocFixed(16);
  mem.copy(p1_0, mul128_0_sysvq0asl(x_345, mem.u64b(y_205)), 16);
  let p0_0 = allocFixed(16);
  mem.copy(p0_0, mul128_0_sysvq0asl(x_345, mem.u64b((y_205 + 8))), 16);
  plusQeQ_0_Iar0t5x_sysvq0asl((p1_0 + 8), mem.u64b(p0_0));
  inc_0_Ineawm41_party5a2l1(p1_0, BigInt((mem.u64b((p1_0 + 8)) < mem.u64b(p0_0))));
  result_202 = mem.u64b(p1_0);
  return result_202;
}

function mulParity_0_sysvq0asl(twoF_0, pow10_1, betaMinus1_1) {
  let result_203;
  let p01_0 = BigInt.asUintN(64, (twoF_0 * mem.u64b(pow10_1)));
  let X60Qx_384 = allocFixed(16);
  mem.copy(X60Qx_384, mul128_0_sysvq0asl(twoF_0, mem.u64b((pow10_1 + 8))), 16);
  let p10_0 = mem.u64b(X60Qx_384);
  let mid_1 = BigInt.asUintN(64, (p01_0 + p10_0));
  result_203 = (!((mid_1 & BigInt.asUintN(64, (1n << BigInt(((64 - betaMinus1_1) | 0))))) === 0n));
  return result_203;
}

function isIntegralEndpoint_0_sysvq0asl(twoF_1, e2_3, minusK_0) {
  let result_204;
  if ((e2_3 < -2)) {
    return false;
  }
  if ((e2_3 <= 9)) {
    return true;
  }
  if ((e2_3 <= 86)) {
    let X60Qx_385 = multipleOfPow5_0_sysvq0asl(twoF_1, minusK_0);
    result_204 = X60Qx_385;
    return result_204;
  }
  result_204 = false;
  return result_204;
}

function isIntegralMidpoint_0_sysvq0asl(twoF_2, e2_4, minusK_1) {
  let result_205;
  if ((e2_4 < -4)) {
    let X60Qx_386 = multipleOfPow2_1_sysvq0asl(twoF_2, ((((minusK_1 - e2_4) | 0) + 1) | 0));
    result_205 = X60Qx_386;
    return result_205;
  }
  if ((e2_4 <= 9)) {
    return true;
  }
  if ((e2_4 <= 86)) {
    let X60Qx_387 = multipleOfPow5_0_sysvq0asl(twoF_2, minusK_1);
    result_205 = X60Qx_387;
    return result_205;
  }
  result_205 = false;
  return result_205;
}

function toDecimal64_0_sysvq0asl(ieeeSignificand_1, ieeeExponent_1) {
  let result_206 = allocFixed(16);
  let kappa_0 = 2;
  let bigDivisor_0 = 1000;
  let smallDivisor_0 = 100;
  let m2_0;
  let e2_5;
  if ((!(ieeeExponent_1 === 0n))) {
    m2_0 = (4503599627370496n | ieeeSignificand_1);
    e2_5 = ((Number(BigInt.asIntN(32, ieeeExponent_1)) - 1075) | 0);
    let X60Qx_388;
    let X60Qx_389;
    if ((0 <= (-e2_5))) {
      X60Qx_389 = ((-e2_5) < 53);
    } else {
      X60Qx_389 = false;
    }
    if (X60Qx_389) {
      let X60Qx_390 = multipleOfPow2_1_sysvq0asl(m2_0, (-e2_5));
      X60Qx_388 = X60Qx_390;
    } else {
      X60Qx_388 = false;
    }
    if (X60Qx_388) {
      mem.copy(result_206, (() => {
        let _o = allocFixed(16);
        mem.setU64(_o, (m2_0 >> BigInt((-e2_5))));
        mem.setI32((_o + 8), 0);
        return _o;
      })(), 16);
      return result_206;
    }
    let X60Qx_391;
    if ((ieeeSignificand_1 === 0n)) {
      X60Qx_391 = (1n < ieeeExponent_1);
    } else {
      X60Qx_391 = false;
    }
    if (X60Qx_391) {
      let X60Qx_392 = allocFixed(16);
      mem.copy(X60Qx_392, toDecimal64AsymmetricInterval_0_sysvq0asl(e2_5), 16);
      mem.copy(result_206, X60Qx_392, 16);
      return result_206;
    }
  } else {
    m2_0 = ieeeSignificand_1;
    e2_5 = (-1074 | 0);
  }
  let isEven_1 = ((m2_0 % 2n) === 0n);
  let acceptLower_0 = isEven_1;
  let acceptUpper_0 = isEven_1;
  let X60Qx_393 = dbFloorLog10Pow2_0_sysvq0asl(e2_5);
  let minusK_3 = ((X60Qx_393 - 2) | 0);
  let X60Qx_394 = dbFloorLog2Pow10_0_sysvq0asl((-minusK_3));
  let betaMinus1_3 = ((e2_5 + X60Qx_394) | 0);
  let pow10_5 = allocFixed(16);
  mem.copy(pow10_5, computePow10_0_sysvq0asl((-minusK_3)), 16);
  let delta_0 = computeDelta_0_sysvq0asl(pow10_5, betaMinus1_3);
  let twoFl_0 = BigInt.asUintN(64, (BigInt.asUintN(64, (2n * m2_0)) - 1n));
  let twoFc_0 = BigInt.asUintN(64, (2n * m2_0));
  let twoFr_0 = BigInt.asUintN(64, (BigInt.asUintN(64, (2n * m2_0)) + 1n));
  let zi_1 = mulShift_0_sysvq0asl(BigInt.asUintN(64, (twoFr_0 << BigInt(betaMinus1_3))), pow10_5);
  let q_6 = allocFixed(8);
  mem.setU64(q_6, (zi_1 / 1000n));
  let r_5 = ((Number(BigInt.asUintN(32, zi_1)) - (Math.imul(1000, Number(BigInt.asUintN(32, mem.u64b(q_6)))) >>> 0)) >>> 0);
  if ((r_5 < delta_0)) {
    let X60Qx_395;
    let X60Qx_396;
    if ((!(r_5 === 0))) {
      X60Qx_396 = true;
    } else {
      X60Qx_396 = acceptUpper_0;
    }
    if (X60Qx_396) {
      X60Qx_395 = true;
    } else {
      let X60Qx_397 = isIntegralEndpoint_0_sysvq0asl(twoFr_0, e2_5, minusK_3);
      X60Qx_395 = (!X60Qx_397);
    }
    if (X60Qx_395) {
      mem.copy(result_206, (() => {
        let _o = allocFixed(16);
        mem.setU64(_o, mem.u64b(q_6));
        mem.setI32((_o + 8), ((((minusK_3 + 2) | 0) + 1) | 0));
        return _o;
      })(), 16);
      return result_206;
    }
    dec_1_Ifi4w3m1_sysvq0asl(q_6);
    r_5 = 1000;
  } else {
    if ((r_5 === delta_0)) {
      let X60Qx_398;
      let X60Qx_399;
      if (acceptLower_0) {
        let X60Qx_400 = isIntegralEndpoint_0_sysvq0asl(twoFl_0, e2_5, minusK_3);
        X60Qx_399 = X60Qx_400;
      } else {
        X60Qx_399 = false;
      }
      if (X60Qx_399) {
        X60Qx_398 = true;
      } else {
        let X60Qx_401 = mulParity_0_sysvq0asl(twoFl_0, pow10_5, betaMinus1_3);
        X60Qx_398 = X60Qx_401;
      }
      if (X60Qx_398) {
        mem.copy(result_206, (() => {
          let _o = allocFixed(16);
          mem.setU64(_o, mem.u64b(q_6));
          mem.setI32((_o + 8), ((((minusK_3 + 2) | 0) + 1) | 0));
          return _o;
        })(), 16);
        return result_206;
      }
    } else {
    }
  }
  mem.setU64(q_6, BigInt.asUintN(64, (mem.u64b(q_6) * 10n)));
  let dist_0 = ((((r_5 - Math.trunc((delta_0 / 2))) >>> 0) + Math.trunc((100 / 2))) >>> 0);
  let distQQ_0 = Math.trunc((dist_0 / 100));
  plusQeQ_0_Iar0t5x_sysvq0asl(q_6, BigInt(distQQ_0));
  if ((dist_0 === (Math.imul(distQQ_0, 100) >>> 0))) {
    let approxYParity_0 = (!(((dist_0 & 1) >>> 0) === 0));
    let X60Qx_402 = mulParity_0_sysvq0asl(twoFc_0, pow10_5, betaMinus1_3);
    if ((!(X60Qx_402 === approxYParity_0))) {
      dec_1_Ifi4w3m1_sysvq0asl(q_6);
    } else {
      let X60Qx_403;
      if ((!((mem.u64b(q_6) % 2n) === 0n))) {
        let X60Qx_404 = isIntegralMidpoint_0_sysvq0asl(twoFc_0, e2_5, minusK_3);
        X60Qx_403 = X60Qx_404;
      } else {
        X60Qx_403 = false;
      }
      if (X60Qx_403) {
        dec_1_Ifi4w3m1_sysvq0asl(q_6);
      }
    }
  }
  mem.copy(result_206, (() => {
    let _o = allocFixed(16);
    mem.setU64(_o, mem.u64b(q_6));
    mem.setI32((_o + 8), ((minusK_3 + 2) | 0));
    return _o;
  })(), 16);
  return result_206;
}

function utoa8DigitsSkipTrailingZeros_0_sysvq0asl(buf_3, pos_3, digits_3) {
  let result_207;
  let q_7 = Math.trunc((digits_3 / 10000));
  let r_6 = (digits_3 % 10000);
  let qH_0 = Math.trunc((q_7 / 100));
  let qL_0 = (q_7 % 100);
  utoa2Digits_0_sysvq0asl(buf_3, pos_3, qH_0);
  utoa2Digits_0_sysvq0asl(buf_3, ((pos_3 + 2) | 0), qL_0);
  if ((r_6 === 0)) {
    let X60Qx_43;
    if ((qL_0 === 0)) {
      X60Qx_43 = qH_0;
    } else {
      X60Qx_43 = qL_0;
    }
    let X60Qx_44;
    if ((qL_0 === 0)) {
      X60Qx_44 = 6;
    } else {
      X60Qx_44 = 4;
    }
    let X60Qx_405 = trailingZeros2Digits_0_sysvq0asl(X60Qx_43);
    result_207 = ((X60Qx_405 + X60Qx_44) | 0);
  } else {
    let rH_1 = Math.trunc((r_6 / 100));
    let rL_1 = (r_6 % 100);
    utoa2Digits_0_sysvq0asl(buf_3, ((pos_3 + 4) | 0), rH_1);
    utoa2Digits_0_sysvq0asl(buf_3, ((pos_3 + 6) | 0), rL_1);
    let X60Qx_45;
    if ((rL_1 === 0)) {
      X60Qx_45 = rH_1;
    } else {
      X60Qx_45 = rL_1;
    }
    let X60Qx_46;
    if ((rL_1 === 0)) {
      X60Qx_46 = 2;
    } else {
      X60Qx_46 = 0;
    }
    let X60Qx_406 = trailingZeros2Digits_0_sysvq0asl(X60Qx_45);
    result_207 = ((X60Qx_406 + X60Qx_46) | 0);
  }
  return result_207;
}

function printDecimalDigitsBackwards_1_sysvq0asl(buf_4, pos_4, output64_0) {
  var result_208;
  var pos_9 = allocFixed(4);
  mem.setI32(pos_9, pos_4);
  var output64_1 = output64_0;
  var tz_2 = allocFixed(4);
  mem.setI32(tz_2, 0);
  var nd_1 = allocFixed(4);
  mem.setI32(nd_1, 0);
  if ((100000000n <= output64_1)) {
    var q_8 = (output64_1 / 100000000n);
    var r_7 = Number(BigInt.asUintN(32, (output64_1 % 100000000n)));
    output64_1 = q_8;
    dec_0_Ig5i8xp_ospaexnw61(pos_9, 8);
    if ((!(r_7 === 0))) {
      var X60Qx_407 = utoa8DigitsSkipTrailingZeros_0_sysvq0asl(buf_4, mem.i32(pos_9), r_7);
      mem.setI32(tz_2, X60Qx_407);
    } else {
      mem.setI32(tz_2, 8);
    }
    mem.setI32(nd_1, 8);
  }
  var output_2 = Number(BigInt.asUintN(32, output64_1));
  if ((10000 <= output_2)) {
    var q_9 = Math.trunc((output_2 / 10000));
    var r_8 = (output_2 % 10000);
    output_2 = q_9;
    dec_0_Ig5i8xp_ospaexnw61(pos_9, 4);
    if ((!(r_8 === 0))) {
      var rH_2 = Math.trunc((r_8 / 100));
      var rL_2 = (r_8 % 100);
      utoa2Digits_0_sysvq0asl(buf_4, mem.i32(pos_9), rH_2);
      utoa2Digits_0_sysvq0asl(buf_4, ((mem.i32(pos_9) + 2) | 0), rL_2);
      if ((mem.i32(tz_2) === mem.i32(nd_1))) {
        var X60Qx_47;
        if ((rL_2 === 0)) {
          X60Qx_47 = rH_2;
        } else {
          X60Qx_47 = rL_2;
        }
        var X60Qx_48;
        if ((rL_2 === 0)) {
          X60Qx_48 = 2;
        } else {
          X60Qx_48 = 0;
        }
        var X60Qx_408 = trailingZeros2Digits_0_sysvq0asl(X60Qx_47);
        inc_0_Iloplki_party5a2l1(tz_2, ((X60Qx_408 + X60Qx_48) | 0));
      }
    } else {
      if ((mem.i32(tz_2) === mem.i32(nd_1))) {
        inc_0_Iloplki_party5a2l1(tz_2, 4);
      } else {
        forStmtLabel_0: {
          {
            whileStmtLabel_1: {
              var X60Qlf_13 = 0;
              var X60Qlf_14 = 3;
              var X60Qlf_15 = allocFixed(4);
              mem.setI32(X60Qlf_15, X60Qlf_13);
              {
                while ((mem.i32(X60Qlf_15) <= X60Qlf_14)) {
                  {
                    putQ_10_If2353w_sysvq0asl(buf_4, ((mem.i32(pos_9) + mem.i32(X60Qlf_15)) | 0), 48);
                  }
                  inc_1_I6wjjge_cmdqs323n1(X60Qlf_15);
                }
              }
            }
          }
        }
      }
    }
    inc_0_Iloplki_party5a2l1(nd_1, 4);
  }
  if ((100 <= output_2)) {
    var q_10 = Math.trunc((output_2 / 100));
    var r_9 = (output_2 % 100);
    output_2 = q_10;
    dec_0_Ig5i8xp_ospaexnw61(pos_9, 2);
    utoa2Digits_0_sysvq0asl(buf_4, mem.i32(pos_9), r_9);
    if ((mem.i32(tz_2) === mem.i32(nd_1))) {
      var X60Qx_409 = trailingZeros2Digits_0_sysvq0asl(r_9);
      inc_0_Iloplki_party5a2l1(tz_2, X60Qx_409);
    }
    inc_0_Iloplki_party5a2l1(nd_1, 2);
    if ((100 <= output_2)) {
      var q2_1 = Math.trunc((output_2 / 100));
      var r2_1 = (output_2 % 100);
      output_2 = q2_1;
      dec_0_Ig5i8xp_ospaexnw61(pos_9, 2);
      utoa2Digits_0_sysvq0asl(buf_4, mem.i32(pos_9), r2_1);
      if ((mem.i32(tz_2) === mem.i32(nd_1))) {
        var X60Qx_410 = trailingZeros2Digits_0_sysvq0asl(r2_1);
        inc_0_Iloplki_party5a2l1(tz_2, X60Qx_410);
      }
      inc_0_Iloplki_party5a2l1(nd_1, 2);
    }
  }
  if ((10 <= output_2)) {
    var q_11 = output_2;
    dec_0_Ig5i8xp_ospaexnw61(pos_9, 2);
    utoa2Digits_0_sysvq0asl(buf_4, mem.i32(pos_9), q_11);
    if ((mem.i32(tz_2) === mem.i32(nd_1))) {
      var X60Qx_411 = trailingZeros2Digits_0_sysvq0asl(q_11);
      inc_0_Iloplki_party5a2l1(tz_2, X60Qx_411);
    }
  } else {
    var q_12 = output_2;
    dec_1_I0nzoz91_envto7w6l1(pos_9);
    var X60Qx_412 = chr_0_sysvq0asl(((48 + q_12) | 0));
    putQ_10_If2353w_sysvq0asl(buf_4, mem.i32(pos_9), X60Qx_412);
  }
  result_208 = mem.i32(tz_2);
  return result_208;
}

function decimalLength_1_sysvq0asl(v_4) {
  let result_209;
  if ((!(Number(BigInt.asUintN(32, (v_4 >> 32n))) === 0))) {
    if ((10000000000000000n <= v_4)) {
      return 17;
    }
    if ((1000000000000000n <= v_4)) {
      return 16;
    }
    if ((100000000000000n <= v_4)) {
      return 15;
    }
    if ((10000000000000n <= v_4)) {
      return 14;
    }
    if ((1000000000000n <= v_4)) {
      return 13;
    }
    if ((100000000000n <= v_4)) {
      return 12;
    }
    if ((10000000000n <= v_4)) {
      return 11;
    }
    return 10;
  }
  let v32_0 = Number(BigInt.asUintN(32, v_4));
  if ((1000000000 <= v32_0)) {
    return 10;
  }
  if ((100000000 <= v32_0)) {
    return 9;
  }
  if ((10000000 <= v32_0)) {
    return 8;
  }
  if ((1000000 <= v32_0)) {
    return 7;
  }
  if ((100000 <= v32_0)) {
    return 6;
  }
  if ((10000 <= v32_0)) {
    return 5;
  }
  if ((1000 <= v32_0)) {
    return 4;
  }
  if ((100 <= v32_0)) {
    return 3;
  }
  if ((10 <= v32_0)) {
    return 2;
  }
  result_209 = 1;
  return result_209;
}

function formatDigits_1_sysvq0asl(buffer_2, pos_5, digits_4, decimalExponent_1, forceTrailingDotZero_2) {
  forStmtLabel_0: {
    var result_210;
    var minFixedDecimalPoint_1 = -6;
    var maxFixedDecimalPoint_1 = 17;
    var pos_10 = allocFixed(4);
    mem.setI32(pos_10, pos_5);
    var numDigits_1 = allocFixed(4);
    mem.setI32(numDigits_1, decimalLength_1_sysvq0asl(digits_4));
    var decimalPoint_1 = ((mem.i32(numDigits_1) + decimalExponent_1) | 0);
    var X60Qx_413;
    if ((-6 <= decimalPoint_1)) {
      X60Qx_413 = (decimalPoint_1 <= 17);
    } else {
      X60Qx_413 = false;
    }
    var useFixed_1 = X60Qx_413;
    {
      whileStmtLabel_1: {
        var X60Qlf_16 = 0;
        var X60Qlf_17 = 32;
        var X60Qlf_18 = allocFixed(4);
        mem.setI32(X60Qlf_18, X60Qlf_16);
        {
          while ((mem.i32(X60Qlf_18) < X60Qlf_17)) {
            {
              putQ_10_If2353w_sysvq0asl(buffer_2, ((mem.i32(pos_10) + mem.i32(X60Qlf_18)) | 0), 48);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_18);
          }
        }
      }
    }
  }
  var decimalDigitsPosition_1;
  if (useFixed_1) {
    if ((decimalPoint_1 <= 0)) {
      decimalDigitsPosition_1 = ((2 - decimalPoint_1) | 0);
    } else {
      decimalDigitsPosition_1 = 0;
    }
  } else {
    decimalDigitsPosition_1 = 1;
  }
  var digitsEnd_1 = allocFixed(4);
  mem.setI32(digitsEnd_1, ((((mem.i32(pos_10) + decimalDigitsPosition_1) | 0) + mem.i32(numDigits_1)) | 0));
  var tz_3 = printDecimalDigitsBackwards_1_sysvq0asl(buffer_2, mem.i32(digitsEnd_1), digits_4);
  dec_0_Ig5i8xp_ospaexnw61(digitsEnd_1, tz_3);
  dec_0_Ig5i8xp_ospaexnw61(numDigits_1, tz_3);
  if (useFixed_1) {
    if ((decimalPoint_1 <= 0)) {
      putQ_10_If2353w_sysvq0asl(buffer_2, ((mem.i32(pos_10) + 1) | 0), 46);
      mem.setI32(pos_10, mem.i32(digitsEnd_1));
    } else {
      if ((decimalPoint_1 < mem.i32(numDigits_1))) {
        forStmtLabel_4: {
          forStmtLabel_2: {
            var tmp_3 = allocFixed(16);
            mem.copy(tmp_3, default_23_I1t3hvc_sysvq0asl(), 16);
            {
              whileStmtLabel_3: {
                var X60Qlf_19 = 0;
                var X60Qlf_20 = 16;
                var X60Qlf_21 = allocFixed(4);
                mem.setI32(X60Qlf_21, X60Qlf_19);
                {
                  while ((mem.i32(X60Qlf_21) < X60Qlf_20)) {
                    {
                      var X60Qx_414 = nimIcheckB(mem.i32(X60Qlf_21), 15);
                      var X60Qx_415 = getQ_10_I5nt6we_has9tn57v(buffer_2, ((((mem.i32(X60Qlf_21) + mem.i32(pos_10)) | 0) + decimalPoint_1) | 0));
                      mem.setU8((tmp_3 + X60Qx_414), mem.u8At(X60Qx_415));
                    }
                    inc_1_I6wjjge_cmdqs323n1(X60Qlf_21);
                  }
                }
              }
            }
          }
          {
            whileStmtLabel_5: {
              var X60Qlf_22 = 0;
              var X60Qlf_23 = 16;
              var X60Qlf_24 = allocFixed(4);
              mem.setI32(X60Qlf_24, X60Qlf_22);
              {
                while ((mem.i32(X60Qlf_24) < X60Qlf_23)) {
                  {
                    var X60Qx_416 = nimIcheckB(mem.i32(X60Qlf_24), 15);
                    putQ_10_If2353w_sysvq0asl(buffer_2, ((((((mem.i32(X60Qlf_24) + mem.i32(pos_10)) | 0) + decimalPoint_1) | 0) + 1) | 0), mem.u8At((tmp_3 + X60Qx_416)));
                  }
                  inc_1_I6wjjge_cmdqs323n1(X60Qlf_24);
                }
              }
            }
          }
        }
        putQ_10_If2353w_sysvq0asl(buffer_2, ((mem.i32(pos_10) + decimalPoint_1) | 0), 46);
        mem.setI32(pos_10, ((mem.i32(digitsEnd_1) + 1) | 0));
      } else {
        inc_0_Iloplki_party5a2l1(pos_10, decimalPoint_1);
        if (forceTrailingDotZero_2) {
          putQ_10_If2353w_sysvq0asl(buffer_2, mem.i32(pos_10), 46);
          putQ_10_If2353w_sysvq0asl(buffer_2, ((mem.i32(pos_10) + 1) | 0), 48);
          inc_0_Iloplki_party5a2l1(pos_10, 2);
        }
      }
    }
  } else {
    var X60Qx_417 = getQ_10_I5nt6we_has9tn57v(buffer_2, ((mem.i32(pos_10) + 1) | 0));
    putQ_10_If2353w_sysvq0asl(buffer_2, mem.i32(pos_10), mem.u8At(X60Qx_417));
    if ((mem.i32(numDigits_1) === 1)) {
      inc_1_I6wjjge_cmdqs323n1(pos_10);
    } else {
      putQ_10_If2353w_sysvq0asl(buffer_2, ((mem.i32(pos_10) + 1) | 0), 46);
      mem.setI32(pos_10, mem.i32(digitsEnd_1));
    }
    var scientificExponent_1 = ((decimalPoint_1 - 1) | 0);
    putQ_10_If2353w_sysvq0asl(buffer_2, mem.i32(pos_10), 101);
    var X60Qx_49;
    if ((scientificExponent_1 < 0)) {
      X60Qx_49 = 45;
    } else {
      X60Qx_49 = 43;
    }
    putQ_10_If2353w_sysvq0asl(buffer_2, ((mem.i32(pos_10) + 1) | 0), X60Qx_49);
    inc_0_Iloplki_party5a2l1(pos_10, 2);
    var X60Qx_50;
    if ((scientificExponent_1 < 0)) {
      X60Qx_50 = (-scientificExponent_1);
    } else {
      X60Qx_50 = scientificExponent_1;
    }
    var k_4 = X60Qx_50;
    if ((k_4 < 10)) {
      var X60Qx_418 = chr_0_sysvq0asl(((48 + k_4) | 0));
      putQ_10_If2353w_sysvq0asl(buffer_2, mem.i32(pos_10), X60Qx_418);
      inc_1_I6wjjge_cmdqs323n1(pos_10);
    } else {
      if ((k_4 < 100)) {
        utoa2Digits_0_sysvq0asl(buffer_2, mem.i32(pos_10), k_4);
        inc_0_Iloplki_party5a2l1(pos_10, 2);
      } else {
        var q_13 = Math.trunc((k_4 / 100));
        var r_10 = (k_4 % 100);
        var X60Qx_419 = chr_0_sysvq0asl(((48 + q_13) | 0));
        putQ_10_If2353w_sysvq0asl(buffer_2, mem.i32(pos_10), X60Qx_419);
        inc_1_I6wjjge_cmdqs323n1(pos_10);
        utoa2Digits_0_sysvq0asl(buffer_2, mem.i32(pos_10), r_10);
        inc_0_Iloplki_party5a2l1(pos_10, 2);
      }
    }
  }
  result_210 = mem.i32(pos_10);
  return result_210;
}

function toChars_0_sysvq0asl(buffer_3, v_5, forceTrailingDotZero_3) {
  let result_211;
  let pos_11 = allocFixed(4);
  mem.setI32(pos_11, 0);
  let double_0 = allocFixed(8);
  mem.copy(double_0, constructDouble_0_sysvq0asl(v_5), 8);
  let significand_1 = physicalSignificand_1_sysvq0asl(double_0);
  let exponent_1 = physicalExponent_1_sysvq0asl(double_0);
  if ((!(exponent_1 === 2047n))) {
    putQ_10_If2353w_sysvq0asl(buffer_3, mem.i32(pos_11), 45);
    let X60Qx_420 = signBit_1_sysvq0asl(double_0);
    inc_0_Iloplki_party5a2l1(pos_11, X60Qx_420);
    let X60Qx_421;
    if ((!(exponent_1 === 0n))) {
      X60Qx_421 = true;
    } else {
      X60Qx_421 = (!(significand_1 === 0n));
    }
    if (X60Qx_421) {
      let dec_1 = allocFixed(16);
      mem.copy(dec_1, toDecimal64_0_sysvq0asl(significand_1, exponent_1), 16);
      let X60Qx_422 = formatDigits_1_sysvq0asl(buffer_3, mem.i32(pos_11), mem.u64b(dec_1), mem.i32((dec_1 + 8)), forceTrailingDotZero_3);
      result_211 = X60Qx_422;
      return result_211;
    } else {
      putQ_10_If2353w_sysvq0asl(buffer_3, mem.i32(pos_11), 48);
      putQ_10_If2353w_sysvq0asl(buffer_3, ((mem.i32(pos_11) + 1) | 0), 46);
      putQ_10_If2353w_sysvq0asl(buffer_3, ((mem.i32(pos_11) + 2) | 0), 48);
      putQ_10_If2353w_sysvq0asl(buffer_3, ((mem.i32(pos_11) + 3) | 0), 32);
      let X60Qx_51;
      if (forceTrailingDotZero_3) {
        X60Qx_51 = 3;
      } else {
        X60Qx_51 = 1;
      }
      inc_0_Iloplki_party5a2l1(pos_11, X60Qx_51);
      return mem.i32(pos_11);
    }
  }
  if ((significand_1 === 0n)) {
    putQ_10_If2353w_sysvq0asl(buffer_3, mem.i32(pos_11), 45);
    let X60Qx_423 = signBit_1_sysvq0asl(double_0);
    inc_0_Iloplki_party5a2l1(pos_11, X60Qx_423);
    putQ_10_If2353w_sysvq0asl(buffer_3, mem.i32(pos_11), 105);
    putQ_10_If2353w_sysvq0asl(buffer_3, ((mem.i32(pos_11) + 1) | 0), 110);
    putQ_10_If2353w_sysvq0asl(buffer_3, ((mem.i32(pos_11) + 2) | 0), 102);
    putQ_10_If2353w_sysvq0asl(buffer_3, ((mem.i32(pos_11) + 3) | 0), 32);
    result_211 = ((mem.i32(pos_11) + 3) | 0);
    return result_211;
  } else {
    putQ_10_If2353w_sysvq0asl(buffer_3, mem.i32(pos_11), 110);
    putQ_10_If2353w_sysvq0asl(buffer_3, ((mem.i32(pos_11) + 1) | 0), 97);
    putQ_10_If2353w_sysvq0asl(buffer_3, ((mem.i32(pos_11) + 2) | 0), 110);
    putQ_10_If2353w_sysvq0asl(buffer_3, ((mem.i32(pos_11) + 3) | 0), 32);
    result_211 = ((mem.i32(pos_11) + 3) | 0);
    return result_211;
  }
  return result_211;
}

function addFloat_0_sysvq0asl(result_0, x_346) {
  forStmtLabel_0: {
    var buffer_4 = allocFixed(65);
    mem.copy(buffer_4, default_23_Insyi17_sysvq0asl(), 65);
    var X60Qx_424 = allocFixed(8);
    mem.copy(X60Qx_424, toOpenArray_0_Iwrwfj81_sysvq0asl(buffer_4), 8);
    var n_8 = toChars_0_sysvq0asl(X60Qx_424, x_346, true);
    {
      whileStmtLabel_1: {
        var X60Qlf_25 = 0;
        var X60Qlf_26 = n_8;
        var X60Qlf_27 = allocFixed(4);
        mem.setI32(X60Qlf_27, X60Qlf_25);
        {
          while ((mem.i32(X60Qlf_27) < X60Qlf_26)) {
            {
              var X60Qx_425 = nimIcheckB(mem.i32(X60Qlf_27), 64);
              add_1_sysvq0asl(result_0, mem.u8At((buffer_4 + X60Qx_425)));
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_27);
          }
        }
      }
    }
  }
}

let exc_0_sysvq0asl = allocFixed(4);

function listAdd_0_Ik4wxhz_sysvq0asl(head_5, c_38) {
  mem.setU32((c_38 + 12), mem.u32(head_5));
  if ((!(mem.u32(head_5) === 0))) {
    mem.setU32((mem.u32(head_5) + 16), c_38);
  }
  mem.setU32(head_5, c_38);
}

function listRemove_0_Ibzev091_sysvq0asl(head_6, c_39) {
  if ((c_39 === mem.u32(head_6))) {
    mem.setU32(head_6, mem.u32((c_39 + 12)));
    if ((!(mem.u32(head_6) === 0))) {
      mem.setU32((mem.u32(head_6) + 16), 0);
    }
  } else {
    mem.setU32((mem.u32((c_39 + 16)) + 12), mem.u32((c_39 + 12)));
    if ((!(mem.u32((c_39 + 12)) === 0))) {
      mem.setU32((mem.u32((c_39 + 12)) + 16), mem.u32((c_39 + 16)));
    }
  }
  mem.setU32((c_39 + 12), 0);
  mem.setU32((c_39 + 16), 0);
}

function raiseIndexError3_0_I113jpc1_sysvq0asl(i_68, a_83, b_38) {
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684957694);
    mem.setU32((_o + 4), strlit_0_I11614695157650328859_sysvq0asl);
    return _o;
  })());
  writeErr_0_sysvq0asl(BigInt(i_68));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869488382);
    mem.setU32((_o + 4), strlit_0_I16845119709590674135_sysvq0asl);
    return _o;
  })());
  writeErr_0_sysvq0asl(BigInt(a_83));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 3026434);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  writeErr_0_sysvq0asl(BigInt(b_38));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2561);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  exit(1);
}

function raiseIndexError3_0_Ic5mmkg_sysvq0asl(i_69, a_84, b_39) {
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1684957694);
    mem.setU32((_o + 4), strlit_0_I11614695157650328859_sysvq0asl);
    return _o;
  })());
  writeErr_1_sysvq0asl(BigInt(i_69));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 1869488382);
    mem.setU32((_o + 4), strlit_0_I16845119709590674135_sysvq0asl);
    return _o;
  })());
  writeErr_1_sysvq0asl(BigInt(a_84));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 3026434);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  writeErr_1_sysvq0asl(BigInt(b_39));
  writeErr_2_sysvq0asl((() => {
    let _o = allocFixed(8);
    mem.setU32(_o, 2561);
    mem.setU32((_o + 4), 0);
    return _o;
  })());
  exit(1);
}

function putQ_10_If2353w_sysvq0asl(x_380, i_70, elem_13) {
  let X60Qx_441;
  if ((0 <= i_70)) {
    X60Qx_441 = (i_70 < mem.i32((x_380 + 4)));
  } else {
    X60Qx_441 = false;
  }
  if ((!X60Qx_441)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14872370265633446329_str7j0ifg);
      return _o;
    })());
  }
  let X60Qx_442 = getQ_10_I5nt6we_has9tn57v(x_380, i_70);
  mem.setU8(X60Qx_442, elem_13);
}

function dec_0_Idgnuqw1_sysvq0asl(x_382, y_218) {
  mem.setU64(x_382, BigInt.asUintN(64, (mem.u64b(x_382) - y_218)));
}

function plusQeQ_0_Iar0t5x_sysvq0asl(x_384, y_220) {
  mem.setU64(x_384, BigInt.asUintN(64, (mem.u64b(x_384) + y_220)));
}

function dec_1_Ifi4w3m1_sysvq0asl(x_385) {
  mem.setU64(x_385, BigInt.asUintN(64, (mem.u64b(x_385) - 1n)));
}

function default_23_I1t3hvc_sysvq0asl() {
  forStmtLabel_0: {
    var result_231 = allocFixed(16);
    {
      whileStmtLabel_1: {
        var X60Qlf_31 = 0;
        var X60Qlf_32 = 15;
        var X60Qlf_33 = allocFixed(4);
        mem.setI32(X60Qlf_33, X60Qlf_31);
        {
          while ((mem.i32(X60Qlf_33) <= X60Qlf_32)) {
            {
              var X60Qx_444 = nimIcheckB(mem.i32(X60Qlf_33), 15);
              mem.setU8((result_231 + X60Qx_444), 0);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_33);
          }
        }
      }
    }
  }
  return result_231;
}

function default_23_Insyi17_sysvq0asl() {
  forStmtLabel_0: {
    var result_232 = allocFixed(65);
    {
      whileStmtLabel_1: {
        var X60Qlf_34 = 0;
        var X60Qlf_35 = 64;
        var X60Qlf_36 = allocFixed(4);
        mem.setI32(X60Qlf_36, X60Qlf_34);
        {
          while ((mem.i32(X60Qlf_36) <= X60Qlf_35)) {
            {
              var X60Qx_445 = nimIcheckB(mem.i32(X60Qlf_36), 64);
              mem.setU8((result_232 + X60Qx_445), 0);
            }
            inc_1_I6wjjge_cmdqs323n1(X60Qlf_36);
          }
        }
      }
    }
  }
  return result_232;
}

function toOpenArray_0_Iwrwfj81_sysvq0asl(x_388) {
  let result_233 = allocFixed(8);
  let X60Qx_52 = allocFixed(8);
  if (((((64 | 0) + 1) | 0) === 0)) {
    mem.copy(X60Qx_52, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 0);
      mem.setI32((_o + 4), 0);
      return _o;
    })(), 8);
  } else {
    mem.copy(X60Qx_52, (() => {
      let _o = allocFixed(8);
      mem.setU32(_o, x_388);
      mem.setI32((_o + 4), (((64 | 0) + 1) | 0));
      return _o;
    })(), 8);
  }
  mem.copy(result_233, X60Qx_52, 8);
  return result_233;
}

function eQwasmovedQ_ArefSX45xception0sysvq0asl_0_sysvq0asl(dest_0) {
  mem.setU32(dest_0, 0);
}

let X60QiniGuard_0_sysvq0asl = allocFixed(1);

function X60Qini_0_sysvq0asl() {
  if (mem.u8At(X60QiniGuard_0_sysvq0asl)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_sysvq0asl, true);
  eQwasmovedQ_ArefSX45xception0sysvq0asl_0_sysvq0asl(exc_0_sysvq0asl);
}
// generated by lengc (js backend) from has9tn57v.c.nif

function len_6_Iroq7kd1_has9tn57v(a_6) {
  let result_19;
  result_19 = mem.i32((a_6 + 4));
  return result_19;
}

function getQ_10_I5nt6we_has9tn57v(x_15, idx_1) {
  let X60Qx_19;
  if ((0 <= idx_1)) {
    X60Qx_19 = (idx_1 < mem.i32((x_15 + 4)));
  } else {
    X60Qx_19 = false;
  }
  if ((!X60Qx_19)) {
    panic_0_sysvq0asl((() => {
      let _o = allocFixed(8);
      mem.setU32(_o, 791555838);
      mem.setU32((_o + 4), strlit_0_I14694606176902936784_has9tn57v);
      return _o;
    })());
  }
  let result_20;
  result_20 = (mem.u32(x_15) + idx_1);
  return result_20;
}

let X60QiniGuard_0_has9tn57v = allocFixed(1);

function X60Qini_0_has9tn57v() {
  if (mem.u8At(X60QiniGuard_0_has9tn57v)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_has9tn57v, true);
  X60Qini_0_sysvq0asl();
}
// generated by lengc (js backend) from syn1lfpjv.c.nif

function write_0_syn1lfpjv(f_6, s_0) {
  let X60Qx_2 = readRawData_0_sysvq0asl(s_0, 0);
  let X60Qx_3 = len_4_sysvq0asl(s_0);
  let X60Qx_4 = fwrite(X60Qx_2, 1, X60Qx_3, f_6);
}

function write_7_syn1lfpjv(f_13, c_1) {
  let X60Qx_5 = fputc(c_1, f_13);
}

function quit_0_syn1lfpjv(value_0) {
  cExit_0_sysvq0asl(value_0);
}

let X60QiniGuard_0_syn1lfpjv = allocFixed(1);

function X60Qini_0_syn1lfpjv() {
  if (mem.u8At(X60QiniGuard_0_syn1lfpjv)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_syn1lfpjv, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_for2ybv4p1();
}
// generated by lengc (js backend) from vfsc9jn7.c.nif

let X60QiniGuard_0_vfsc9jn7 = allocFixed(1);

function X60Qini_0_vfsc9jn7() {
  if (mem.u8At(X60QiniGuard_0_vfsc9jn7)) {
    return;
  }
  mem.setU8(X60QiniGuard_0_vfsc9jn7, true);
  X60Qini_0_sysvq0asl();
  X60Qini_0_memlzdyby();
  X60Qini_0_syn1lfpjv();
  X60Qini_0_timsagyye1();
  X60Qini_0_oswd7dmm();
  X60Qini_0_cmdqs323n1();
  X60Qini_0_ospaexnw61();
  X60Qini_0_osalirkw71();
  X60Qini_0_osc4bsu0d1();
  X60Qini_0_ossk30t39();
  X60Qini_0_dir38pj6l();
  X60Qini_0_pat4k2dls();
}
