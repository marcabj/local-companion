@main struct PCMTests {
    static func main() throws {
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
