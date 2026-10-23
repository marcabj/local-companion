import Foundation
import AVFoundation
import CoreAudio
import AppKit

let outputLock = NSLock()

func emit(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value) else { return }
    outputLock.lock(); defer { outputLock.unlock() }
    FileHandle.standardOutput.write(data + Data([10]))
}

final class Segmenter {
    let source: String
    let directory: String
    var samples: [Float] = []
    var preRoll: [Float] = []
    var silent = 0
    var voiced = 0
    var started = 0.0
    var lastMeter = 0.0
    init(_ source: String, _ directory: String) { self.source = source; self.directory = directory }
    func append(_ pcm: AVAudioPCMBuffer) throws {
        guard let pointer = pcm.floatChannelData?[0], pcm.frameLength > 0 else { return }
        let data = Array(UnsafeBufferPointer(start: pointer, count: Int(pcm.frameLength)))
        let rms = sqrt(data.reduce(Float(0)) { $0 + $1 * $1 } / Float(data.count))
        let now = Date().timeIntervalSince1970
        if now - lastMeter > 0.15 { emit(["type": "level", "source": source, "value": min(1, rms * 8)]); lastMeter = now }
        let isVoice = rms > 0.004
        if samples.isEmpty {
            if isVoice { samples = preRoll; started = now - Double(preRoll.count) / 16000; preRoll.removeAll() }
            else { preRoll.append(contentsOf: data); if preRoll.count > 4000 { preRoll.removeFirst(preRoll.count - 4000) }; return }
        }
        samples.append(contentsOf: data)
        if isVoice { silent = 0; voiced += data.count } else { silent += data.count }
        if silent >= 9600 || samples.count >= 128000 { try flush() }
    }
    func flush() throws {
        defer { samples.removeAll(keepingCapacity: true); silent = 0; voiced = 0 }
        guard voiced >= 1600, !samples.isEmpty else { return }
        let url = URL(fileURLWithPath: directory).appendingPathComponent(UUID().uuidString + ".wav")
        let format = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count))!
        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in buffer.floatChannelData![0].update(from: source.baseAddress!, count: source.count) }
        do {
            let file = try AVAudioFile(forWriting: url, settings: [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1, AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsBigEndianKey: false])
            try file.write(from: buffer)
        }
        emit(["type": "segment", "path": url.path, "source": source, "at": started])
    }
}

// Audio-only capture: Core Audio process tap for playback, AVFoundation for mic.
final class Capture: NSObject, AVCaptureAudioDataOutputSampleBufferDelegate, @unchecked Sendable {
    let queue = DispatchQueue(label: "local.companion.capture")
    let slots = DispatchSemaphore(value: 24)
    let faultLock = NSLock()
    var ioFaultQueued = false
    let converters = [PCMConverter(), PCMConverter()]
    let segmenters: [Segmenter]
    let microphoneSession = AVCaptureSession()
    var tap: AudioObjectID = 0
    var aggregate: AudioObjectID = 0
    var io: AudioDeviceIOProcID?
    var failed = false // Accessed only on queue.
    var configurationObserver: NSObjectProtocol?
    init(directory: String) { segmenters = [Segmenter("Me", directory), Segmenter("Computer", directory)] }
    func start(microphone: String, pid: Int32?) async throws {
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            throw AudioError.message("Allow Local Companion microphone access in System Settings → Privacy & Security → Microphone, then reopen the app.")
        }
        emit(["type": "status", "message": "Starting microphone and audio-only computer capture…"])
        do {
            try startComputer(pid: pid)
            try startMicrophone(uid: microphone)
            emit(["type": "started", "backend": "core-audio-process-tap"])
        } catch {
            await stop()
            throw error
        }
    }
    func startComputer(pid: Int32?) throws {
        let processes = AudioProcesses.all()
        let description: CATapDescription
        if let pid {
            guard let process = processes.first(where: { $0.pid == pid }) else {
                throw AudioError.message("The selected audio process is no longer available. Refresh the audio application list or select All applications.")
            }
            description = CATapDescription(stereoMixdownOfProcesses: [process.id])
        } else {
            let excluded = processes.filter { $0.pid == getpid() || $0.bundleID.hasPrefix("local.marc.companion") }.map(\.id)
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: excluded)
        }
        description.name = "Local Companion computer audio"
        description.uuid = UUID()
        description.isPrivate = true
        description.muteBehavior = .unmuted
        try checkAudio(AudioHardwareCreateProcessTap(description, &tap), "Create system audio tap")
        var address = AudioObjectPropertyAddress(mSelector: kAudioTapPropertyFormat, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var asbd = AudioStreamBasicDescription()
        var size = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
        try checkAudio(AudioObjectGetPropertyData(tap, &address, 0, nil, &size, &asbd), "Read system audio format")
        guard let format = AVAudioFormat(streamDescription: &asbd), asbd.mBytesPerFrame > 0 else {
            throw AudioError.message("Unsupported system audio format.")
        }
        let options: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Local Companion audio capture",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapUIDKey: description.uuid.uuidString, kAudioSubTapDriftCompensationKey: true]]
        ]
        try checkAudio(AudioHardwareCreateAggregateDevice(options as CFDictionary, &aggregate), "Create system audio input")
        try checkAudio(AudioDeviceCreateIOProcIDWithBlock(&io, aggregate, nil) { [weak self] _, input, _, _, _ in
            guard let self else { return }
            let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))
            guard let first = buffers.first, first.mDataByteSize > 0 else { return }
            // Bound queued PCM; never resample, write files or run ASR in the I/O callback.
            guard self.slots.wait(timeout: .now()) == .success else {
                self.failFromIO("Audio processing cannot keep up. Pause and restart listening."); return
            }
            do {
                let copy = try copyPCM(input, format: format)
                self.queue.async {
                    defer { self.slots.signal() }
                    do { try self.segmenters[1].append(self.converters[1].convert(copy)) }
                    catch { self.fail(error.localizedDescription) }
                }
            } catch {
                self.slots.signal()
                let message = error.localizedDescription
                self.failFromIO(message)
            }
        }, "Attach system audio callback")
        try checkAudio(AudioDeviceStart(aggregate, io), "Start system audio capture; allow Local Companion under Screen & System Audio Recording if prompted")
    }
    func startMicrophone(uid: String) throws {
        let device: AVCaptureDevice?
        if uid.isEmpty { device = AVCaptureDevice.default(for: .audio) }
        else {
            device = microphones().first { $0.uniqueID == uid } ?? AVCaptureDevice.default(for: .audio)
            if let device, device.uniqueID != uid {
                emit(["type": "status", "message": "Selected microphone disconnected; using \(device.localizedName)."])
            }
        }
        guard let device else { throw AudioError.message("The selected microphone is unavailable. Choose the system default microphone in Settings.") }
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureAudioDataOutput()
        // Device defaults can expose multichannel layouts AVAudioPCMBuffer cannot
        // represent. Negotiate the mono PCM format used by speech recognition.
        output.audioSettings = [AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16000, AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsBigEndianKey: false, AVLinearPCMIsNonInterleaved: false]
        guard microphoneSession.canAddInput(input), microphoneSession.canAddOutput(output) else {
            throw AudioError.message("Cannot open the selected microphone.")
        }
        microphoneSession.addInput(input)
        microphoneSession.addOutput(output)
        output.setSampleBufferDelegate(self, queue: queue)
        configurationObserver = NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: microphoneSession, queue: nil) { [weak self] note in
            let message = (note.userInfo?[AVCaptureSessionErrorKey] as? Error)?.localizedDescription ?? "Microphone capture stopped. Check your audio device and restart Listen."
            self?.queue.async { self?.fail(message) }
        }
        microphoneSession.startRunning()
        guard microphoneSession.isRunning else { throw AudioError.message("Microphone capture did not start.") }
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sample: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard sample.isValid else { return }
        do { try segmenters[0].append(converters[0].read(sample)) }
        catch { fail(error.localizedDescription) }
    }
    func failFromIO(_ message: String) {
        faultLock.lock(); defer { faultLock.unlock() }
        guard !ioFaultQueued else { return }; ioFaultQueued = true
        queue.async { self.fail(message) }
    }
    func fail(_ message: String) {
        guard !failed else { return }; failed = true
        emit(["type": "error", "message": message])
    }
    func stop() async {
        if let observer = configurationObserver { NotificationCenter.default.removeObserver(observer); configurationObserver = nil }
        microphoneSession.stopRunning()
        if aggregate != 0, let io { AudioDeviceStop(aggregate, io); AudioDeviceDestroyIOProcID(aggregate, io) }
        io = nil
        if aggregate != 0 { AudioHardwareDestroyAggregateDevice(aggregate); aggregate = 0 }
        if tap != 0 { AudioHardwareDestroyProcessTap(tap); tap = 0 }
        await flush()
    }
    func flush() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            queue.async { for segmenter in self.segmenters { do { try segmenter.flush() } catch { self.fail(error.localizedDescription) } }; continuation.resume() }
        }
    }
}

func microphones() -> [AVCaptureDevice] {
    AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
}

func checkAudio(_ status: OSStatus, _ operation: String) throws {
    guard status == noErr else { throw AudioError.message("\(operation) failed (Core Audio \(status)).") }
}

func copyPCM(_ list: UnsafePointer<AudioBufferList>, format: AVAudioFormat) throws -> AVAudioPCMBuffer {
    let source = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: list))
    let bytesPerFrame = format.streamDescription.pointee.mBytesPerFrame
    guard let first = source.first, bytesPerFrame > 0, first.mDataByteSize % bytesPerFrame == 0 else { throw AudioError.message("Invalid system audio buffer.") }
    let frames = first.mDataByteSize / bytesPerFrame
    guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames) else { throw AudioError.message("Empty system audio buffer.") }
    pcm.frameLength = frames
    let destination = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
    guard source.count == destination.count else { throw AudioError.message("System audio channel layout changed. Restart Listen.") }
    for index in 0..<source.count {
        guard let from = source[index].mData, let to = destination[index].mData, source[index].mDataByteSize == destination[index].mDataByteSize else { throw AudioError.message("System audio format changed. Restart Listen.") }
        memcpy(to, from, Int(source[index].mDataByteSize))
    }
    return pcm
}

struct AudioProcess {
    let id: AudioObjectID
    let pid: pid_t
    let bundleID: String
    var name: String { NSRunningApplication(processIdentifier: pid)?.localizedName ?? (bundleID.isEmpty ? "Audio process \(pid)" : bundleID) }
}
enum AudioProcesses {
    static func all() -> [AudioProcess] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard ids.withUnsafeMutableBytes({ AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, $0.baseAddress!) }) == noErr else { return [] }
        return ids.compactMap { id in
            var address = AudioObjectPropertyAddress(mSelector: kAudioProcessPropertyPID, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
            var pid: pid_t = 0, size = UInt32(MemoryLayout<pid_t>.size)
            guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, &pid) == noErr, pid > 0 else { return nil }
            return AudioProcess(id: id, pid: pid, bundleID: Devices.property(id, kAudioProcessPropertyBundleID))
        }
    }
}

@main struct Entry {
    static func value(_ name: String) -> String {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: name), i + 1 < args.count else { return "" }
        return args[i + 1]
    }
    static func main() async {
        do {
            if CommandLine.arguments.contains("--test-wav") {
                let file = try AVAudioFile(forReading: URL(fileURLWithPath: value("--test-wav")))
                let directory = value("--output")
                try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
                let segmenter = Segmenter("Fixture", directory)
                let converter = PCMConverter()
                while file.framePosition < file.length {
                    let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 4800)!
                    try file.read(into: buffer)
                    try segmenter.append(converter.convert(buffer))
                }
                try segmenter.flush(); return
            }
            if CommandLine.arguments.contains("--devices") {
                emit(["microphones": microphones().map { ["id": $0.uniqueID, "name": $0.localizedName] }]); return
            }
            if CommandLine.arguments.contains("--sources") {
                emit(["applications": AudioProcesses.all().filter { !$0.bundleID.hasPrefix("local.marc.companion") }.map { ["pid": $0.pid, "name": $0.name] }]); return
            }
            let directory = value("--listen")
            guard !directory.isEmpty else { throw AudioError.message("Expected --listen DIRECTORY, --sources, or --devices.") }
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true)
            let capture = Capture(directory: directory)
            try await capture.start(microphone: value("--microphone"), pid: Int32(value("--pid")))
            while let command = await Task.detached(operation: { readLine() }).value {
                if command.hasPrefix("flush:") {
                    await capture.flush()
                    emit(["type": "flushed", "id": String(command.dropFirst(6))])
                } else { break }
            }
            await capture.stop()
        } catch { emit(["type": "error", "message": error.localizedDescription]); exit(1) }
    }
}

struct AudioDevice {
    let id: AudioDeviceID
    let name: String
    let uid: String
    let inputs: Int
    let outputs: Int
}

enum Devices {
    static func property(_ id: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var value: CFString?
        var size = UInt32(MemoryLayout<CFString?>.size)
        let result = withUnsafeMutablePointer(to: &value) { AudioObjectGetPropertyData(id, &address, 0, nil, &size, $0) }
        guard result == noErr, let value else { return "" }
        return value as String
    }
    static func channels(_ id: AudioDeviceID, _ scope: AudioObjectPropertyScope) -> Int {
        var address = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreamConfiguration, mScope: scope, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(id, &address, 0, nil, &size) == noErr, size > 0 else { return 0 }
        let memory = UnsafeMutableRawPointer.allocate(byteCount: Int(size), alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { memory.deallocate() }
        guard AudioObjectGetPropertyData(id, &address, 0, nil, &size, memory) == noErr else { return 0 }
        return UnsafeMutableAudioBufferListPointer(memory.assumingMemoryBound(to: AudioBufferList.self)).reduce(0) { $0 + Int($1.mNumberChannels) }
    }
    static func all() -> [AudioDevice] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else { return [] }
        var ids = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        let status = ids.withUnsafeMutableBytes { AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, $0.baseAddress!) }
        guard status == noErr else { return [] }
        return ids.map { AudioDevice(id: $0, name: property($0, kAudioObjectPropertyName), uid: property($0, kAudioDevicePropertyDeviceUID), inputs: channels($0, kAudioObjectPropertyScopeInput), outputs: channels($0, kAudioObjectPropertyScopeOutput)) }
    }
    static var virtual: AudioDevice? { all().first { $0.name == "BlackHole 2ch" && $0.inputs > 0 && $0.outputs > 0 } }
    static var defaultInput: AudioDeviceID {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var id: AudioDeviceID = 0
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &id)
        return id
    }
}

enum AudioError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

final class PCMConverter {
    private var converter: AVAudioConverter?
    private let target = AVAudioFormat(standardFormatWithSampleRate: 16000, channels: 1)!
    func convert(_ input: AVAudioPCMBuffer) throws -> AVAudioPCMBuffer {
        if converter?.inputFormat != input.format {
            converter = AVAudioConverter(from: input.format, to: target)
            converter?.primeMethod = .none
        }
        guard let converter else { throw AudioError.message("Unsupported captured audio format.") }
        let size = AVAudioFrameCount(ceil(Double(input.frameLength) * 16000 / input.format.sampleRate) + 128)
        let output = AVAudioPCMBuffer(pcmFormat: target, frameCapacity: size)!
        var supplied = false
        var error: NSError?
        let status = converter.convert(to: output, error: &error) { _, state in
            if supplied { state.pointee = .noDataNow; return nil }
            supplied = true; state.pointee = .haveData; return input
        }
        if status == .error { throw error ?? AudioError.message("Audio conversion failed.") as NSError }
        return output
    }
    func read(_ sample: CMSampleBuffer) throws -> AVAudioPCMBuffer {
        guard let description = CMSampleBufferGetFormatDescription(sample) else { throw AudioError.message("Missing captured audio format.") }
        // The non-failable cmAudioFormatDescription initializer can return nil
        // for unsupported layouts, which crashes inside AVAudioPCMBuffer.
        guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              asbd.pointee.mFormatID == kAudioFormatLinearPCM,
              asbd.pointee.mSampleRate > 0, asbd.pointee.mChannelsPerFrame > 0,
              let format = AVAudioFormat(streamDescription: asbd) else {
            throw AudioError.message("Unsupported captured audio format. Choose another microphone and retry Listen.")
        }
        let length = CMSampleBufferGetNumSamples(sample)
        guard length > 0, let pcm = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(length)) else { throw AudioError.message("Empty captured audio.") }
        pcm.frameLength = AVAudioFrameCount(length)
        var required = 0
        var block: CMBlockBuffer?
        var status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: &required, bufferListOut: nil, bufferListSize: 0, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &block)
        guard status == noErr else { throw AudioError.message("Couldn't read captured audio (\(status)).") }
        let memory = UnsafeMutableRawPointer.allocate(byteCount: required, alignment: MemoryLayout<AudioBufferList>.alignment)
        defer { memory.deallocate() }
        status = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(sample, bufferListSizeNeededOut: nil, bufferListOut: memory.assumingMemoryBound(to: AudioBufferList.self), bufferListSize: required, blockBufferAllocator: nil, blockBufferMemoryAllocator: nil, flags: 0, blockBufferOut: &block)
        guard status == noErr else { throw AudioError.message("Couldn't copy captured audio (\(status)).") }
        let source = UnsafeMutableAudioBufferListPointer(memory.assumingMemoryBound(to: AudioBufferList.self))
        let destination = UnsafeMutableAudioBufferListPointer(pcm.mutableAudioBufferList)
        guard source.count == destination.count else { throw AudioError.message("Audio channel layout changed.") }
        for index in 0..<source.count {
            guard let from = source[index].mData, let to = destination[index].mData, source[index].mDataByteSize <= destination[index].mDataByteSize else { throw AudioError.message("Invalid captured audio buffer.") }
            memcpy(to, from, Int(source[index].mDataByteSize))
        }
        return try convert(pcm)
    }
}
