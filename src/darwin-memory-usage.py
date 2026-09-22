"""Read Darwin's per-process physical footprint; never inspect process contents.

The rusage_info_v2 ABI is defined by Apple's sys/resource.h (macOS 10.9+).
Physical footprint includes charged memory that RSS omits, notably Metal and
compressed allocations. A failed per-PID observation stays absent.
"""
import ctypes
import json
import sys


class RusageInfoV2(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [
        (name, ctypes.c_uint64) for name in (
            'user_time', 'system_time', 'pkg_idle_wkups', 'interrupt_wkups',
            'pageins', 'wired_size', 'resident_size', 'phys_footprint',
            'proc_start_abstime', 'proc_exit_abstime', 'child_user_time',
            'child_system_time', 'child_pkg_idle_wkups', 'child_interrupt_wkups',
            'child_pageins', 'child_elapsed_abstime', 'diskio_bytesread',
            'diskio_byteswritten'
        )
    ]


def main():
    libproc = ctypes.CDLL('/usr/lib/libproc.dylib')
    libproc.proc_pid_rusage.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    libproc.proc_pid_rusage.restype = ctypes.c_int
    result = {}
    for value in sys.argv[1:]:
        pid = int(value)
        if not 0 < pid < 2 ** 31:
            continue
        usage = RusageInfoV2()
        if libproc.proc_pid_rusage(pid, 2, ctypes.byref(usage)) == 0:
            result[str(pid)] = usage.phys_footprint
    print(json.dumps(result))


if __name__ == '__main__':
    main()
