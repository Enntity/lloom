// SPDX-License-Identifier: MIT
// Adapted from Tessera MachineMonitor.swift, commit 8a6e80256cfc8c739d2fd4ff360311d858a8f890.
// See LICENSE-TESSERA. Read-only, no privileges, no command-line input.
import Darwin
import Foundation
import IOKit

enum AppleGPU {
    static func gpuUtilization() -> Double? {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &iterator) == KERN_SUCCESS else { return nil }
        defer { IOObjectRelease(iterator) }
        var best: Double?
        var service = IOIteratorNext(iterator)
        while service != 0 {
            var props: Unmanaged<CFMutableDictionary>?
            if IORegistryEntryCreateCFProperties(service, &props, kCFAllocatorDefault, 0) == KERN_SUCCESS,
               let dict = props?.takeRetainedValue() as? [String: Any],
               let perf = dict["PerformanceStatistics"] as? [String: Any],
               let util = (perf["Device Utilization %"] as? NSNumber)?.doubleValue {
                best = max(best ?? 0, util / 100)
            }
            IOObjectRelease(service)
            service = IOIteratorNext(iterator)
        }
        return best
    }
}

final class ThermalSensors {
    private typealias CreateFn = @convention(c) (CFAllocator?) -> Unmanaged<AnyObject>?
    private typealias SetMatchingFn = @convention(c) (AnyObject, CFDictionary) -> Int32
    private typealias CopyServicesFn = @convention(c) (AnyObject) -> Unmanaged<CFArray>?
    private typealias CopyEventFn = @convention(c) (AnyObject, Int64, Int32, Int64) -> Unmanaged<AnyObject>?
    private typealias FloatValueFn = @convention(c) (AnyObject, Int32) -> Double
    private typealias CopyPropertyFn = @convention(c) (AnyObject, CFString) -> Unmanaged<AnyObject>?

    /// The services belong to the client; it must outlive them or reads touch freed memory.
    private var client: AnyObject?
    private var services: [AnyObject] = []
    private var copyEvent: CopyEventFn?
    private var floatValue: FloatValueFn?

    private static let temperatureEvent: Int64 = 15

    init() {
        guard let h = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW),
              let c = dlsym(h, "IOHIDEventSystemClientCreate"), let m = dlsym(h, "IOHIDEventSystemClientSetMatching"),
              let s = dlsym(h, "IOHIDEventSystemClientCopyServices"), let e = dlsym(h, "IOHIDServiceClientCopyEvent"),
              let f = dlsym(h, "IOHIDEventGetFloatValue"), let p = dlsym(h, "IOHIDServiceClientCopyProperty") else { return }
        let create = unsafeBitCast(c, to: CreateFn.self)
        let setMatching = unsafeBitCast(m, to: SetMatchingFn.self)
        let copyServices = unsafeBitCast(s, to: CopyServicesFn.self)
        let copyProperty = unsafeBitCast(p, to: CopyPropertyFn.self)
        copyEvent = unsafeBitCast(e, to: CopyEventFn.self)
        floatValue = unsafeBitCast(f, to: FloatValueFn.self)
        guard let client = create(kCFAllocatorDefault)?.takeRetainedValue() else { return }
        self.client = client
        // Vendor page 0xff00, usage 5: temperature sensors.
        _ = setMatching(client, ["PrimaryUsagePage": 0xff00, "PrimaryUsage": 5] as CFDictionary)
        let all = (copyServices(client)?.takeRetainedValue() as? [AnyObject]) ?? []
        // Die sensors describe the SoC; fall back to everything except calibration entries.
        let named = all.map { ($0, (copyProperty($0, "Product" as CFString)?.takeRetainedValue() as? String) ?? "") }
        let dies = named.filter { $0.1.contains("tdie") }.map(\.0)
        services = dies.isEmpty ? named.filter { !$0.1.contains("tcal") }.map(\.0) : dies
    }

    func hottestDie() -> Double? {
        guard let copyEvent, let floatValue else { return nil }
        let field = Int32(Self.temperatureEvent << 16)
        let values = services.compactMap { svc -> Double? in
            guard let event = copyEvent(svc, Self.temperatureEvent, 0, 0)?.takeRetainedValue() else { return nil }
            let v = floatValue(event, field)
            return v > 0 && v < 150 ? v : nil
        }
        return values.max()
    }
}


let thermal = ThermalSensors()
let gpu = AppleGPU.gpuUtilization()
let temperature = thermal.hottestDie()
let result: [String: Any] = [
    "schema": 1,
    "gpuUtilization": gpu.map { $0 * 100 } as Any? ?? NSNull(),
    "hottestDieC": temperature as Any? ?? NSNull()
]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
FileHandle.standardOutput.write(data)
FileHandle.standardOutput.write(Data([10]))
