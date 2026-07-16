type
  SysLockAttr* {.importc: "pthread_mutexattr_t", pure, final
             header: "<pthread.h>".} = object

  SysCondObj {.importc: "pthread_cond_t", pure, final,
             header: "<pthread.h>", byref.} = object
