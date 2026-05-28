const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

async function test() {
  try {
    const { Innertube, UniversalCache, Platform } = await import('youtubei.js');
    Platform.shim.eval = async (data) => new Function(data.output)();

    console.log('Innertube creating...');
    const yt = await Innertube.create({
      generate_session_locally: true,
      retrieve_player: true,
      cache: new UniversalCache(false),
    });
    console.log('Innertube created.');
    
    const videoId = 'dQw4w9WgXcQ';
    const details = await yt.getInfo(videoId);
    const formats = details.streaming_data?.formats || [];
    const itag18 = formats.find(f => f.itag === 18);
    
    if (!itag18) {
      console.error('itag 18 format not found');
      return;
    }
    
    console.log('Deciphering...');
    const streamUrl = await itag18.decipher(yt.session.player);
    console.log('Stream URL:', streamUrl.substring(0, 100) + '...');
    
    const ffmpegPath = require('ffmpeg-static');
    const tempPath = path.join(os.tmpdir(), `test-ffmpeg-${videoId}.mp3`);
    console.log('Temp path:', tempPath);
    
    console.log('Spawning ffmpeg...');
    const ffmpeg = spawn(ffmpegPath, [
      '-i', streamUrl,
      '-vn',
      '-acodec', 'libmp3lame',
      '-b:a', '128k',
      '-f', 'mp3',
      '-y',
      tempPath
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    
    ffmpeg.stdout.on('data', (data) => {
      console.log('STDOUT:', data.toString());
    });
    
    ffmpeg.stderr.on('data', (data) => {
      console.log('STDERR:', data.toString());
    });
    
    ffmpeg.on('close', (code) => {
      console.log(`FFmpeg exited with code ${code}`);
      if (fs.existsSync(tempPath)) {
        console.log(`File created: ${tempPath}, size: ${fs.statSync(tempPath).size} bytes`);
        try { fs.unlinkSync(tempPath); } catch (e) {}
      } else {
        console.log('File not created.');
      }
    });
    
  } catch (err) {
    console.error('Error in test:', err);
  }
}

test();
