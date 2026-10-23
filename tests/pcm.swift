@main struct PCMTests {
    static func main() throws {
        // AVCapture can provide multichannel PCM without a channel-layout tag.
        // Exercise the CMSampleBuffer path used by the microphone, not just convert().
        for channels: AVAudioChannelCount in [1, 2, 3] {
            emit(["test": "microphone", "channels": channels])
            var asbd = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatLinearPCM, mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked, mBytesPerPacket: channels * 4, mFramesPerPacket: 1, mBytesPerFrame: channels * 4, mChannelsPerFrame: channels, mBitsPerChannel: 32, mReserved: 0)
            var description: CMAudioFormatDescription?
            precondition(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &description) == noErr)
            var block: CMBlockBuffer?
            let bytes = 4800 * Int(channels) * 4
            precondition(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block) == noErr)
            precondition(CMBlockBufferFillDataBytes(with: 0, blockBuffer: block!, offsetIntoDestination: 0, dataLength: bytes) == noErr)
            var sample: CMSampleBuffer?
            var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48000), presentationTimeStamp: .zero, decodeTimeStamp: .invalid)
            var sampleSize = Int(asbd.mBytesPerFrame)
            precondition(CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: description!, sampleCount: 4800, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1, sampleSizeArray: &sampleSize, sampleBufferOut: &sample) == noErr)
            if channels == 3 {
                do { _ = try PCMConverter().read(sample!); fatalError("Accepted unsupported channel layout") }
                catch { precondition(error.localizedDescription.contains("Unsupported captured audio format")) }
                print("PASS: unsupported microphone layout throws instead of crashing")
                continue
            }
            let output = try PCMConverter().read(sample!)
            precondition(output.format.channelCount == 1 && output.format.sampleRate == 16000 && output.frameLength > 0)
            print("PASS: microphone CMSampleBuffer with \(channels) channels and no layout")
        }
        for interleaved in [true, false] {
            let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 2, interleaved: interleaved)!
            let source = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4800)!
            source.frameLength = 4800
            let list = source.mutableAudioBufferList
            let buffers = UnsafeMutableAudioBufferListPointer(list)
            for buffer in buffers {
                let floats = buffer.mData!.assumingMemoryBound(to: Float.self)
                for index in 0..<Int(buffer.mDataByteSize)/4 { floats[index] = 0.25 }
            }
            let copy = try copyPCM(UnsafePointer(list), format: format)
            // Callback memory may be reused immediately after return; copied data must survive.
            for buffer in buffers { memset(buffer.mData!, 0, Int(buffer.mDataByteSize)) }
            let converter = PCMConverter()
            var lengths: [Int] = []
            var output = try converter.convert(copy)
            lengths.append(Int(output.frameLength))
            for _ in 0..<9 { output = try converter.convert(copy); lengths.append(Int(output.frameLength)) }
            emit(["layout": interleaved ? "interleaved" : "planar", "frameCounts": lengths])
            precondition(output.format.sampleRate == 16000 && output.format.channelCount == 1)
            // AVAudioConverter batches output internally; assert total duration, not one-call size.
            let total = lengths.reduce(0, +)
            precondition(total >= 15500 && total <= 16000, "Resampling duration differs by more than internal buffering")
            let count = Int(output.frameLength)
            let samples = output.floatChannelData![0]
            let average = (100..<count).reduce(Float(0)) { $0 + samples[$1] } / Float(count - 100)
            precondition(abs(average - 0.25) < 0.01, "Captured speech amplitude was corrupted")
            // A truncated channel must be rejected, rather than read beyond supplied PCM.
            let previousSize = buffers[0].mDataByteSize
            buffers[0].mDataByteSize = previousSize - 1
            do { _ = try copyPCM(UnsafePointer(list), format: format); fatalError("Accepted malformed PCM") }
            catch { }
            print("PASS: \(interleaved ? "interleaved" : "planar") copy, ownership, resampling and invalid-buffer rejection")
        }
    }
}
