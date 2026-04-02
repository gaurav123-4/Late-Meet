// Offscreen Document — Audio capture and Whisper transcription
// This runs in an offscreen context to capture tab audio via MediaRecorder
// and send chunks to OpenAI Whisper for multilingual transcription

let mediaRecorder = null;
let audioStream = null;
let recordingInterval = null;

// ——— Receive messages from background ———
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'START_CAPTURE':
      startCapture(message.streamId);
      sendResponse({ success: true });
      break;
      
    case 'STOP_CAPTURE':
      stopCapture();
      sendResponse({ success: true });
      break;
  }
  return true;
});

/**
 * Start capturing audio from the tab
 */
async function startCapture(streamId) {
  try {
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });
    
    console.log('[Offscreen] Audio stream obtained');
    startRecordingLoop();
  } catch (err) {
    console.error('[Offscreen] Failed to get audio stream:', err);
  }
}

/**
 * Start the recording loop — record 10-second chunks and send to Whisper
 */
function startRecordingLoop() {
  if (!audioStream) return;
  
  function recordChunk() {
    if (!audioStream || !audioStream.active) {
      console.log('[Offscreen] Stream no longer active');
      return;
    }
    
    const chunks = [];
    mediaRecorder = new MediaRecorder(audioStream, {
      mimeType: 'audio/webm;codecs=opus'
    });
    
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data);
      }
    };
    
    mediaRecorder.onstop = async () => {
      if (chunks.length > 0) {
        const blob = new Blob(chunks, { type: 'audio/webm' });
        
        // Only process if blob has meaningful audio (> 1KB)
        if (blob.size > 1024) {
          await transcribeChunk(blob);
        }
      }
    };
    
    mediaRecorder.start();
    
    // Stop after 10 seconds to create a chunk
    setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
      }
    }, 10000);
  }
  
  // Start first chunk immediately
  recordChunk();
  
  // Then record a new chunk every 12 seconds (10s recording + 2s gap for processing)
  recordingInterval = setInterval(recordChunk, 12000);
}

/**
 * Send audio chunk to Whisper for transcription
 */
async function transcribeChunk(audioBlob) {
  try {
    const result = await chrome.storage.local.get('openai_api_key');
    const apiKey = result.openai_api_key;
    
    if (!apiKey) {
      console.warn('[Offscreen] No API key — skipping transcription');
      return;
    }
    
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', 'whisper-1');
    formData.append('response_format', 'verbose_json');
    
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}` },
      body: formData
    });
    
    if (!response.ok) {
      console.error('[Offscreen] Whisper error:', response.status);
      return;
    }
    
    const data = await response.json();
    
    if (data.text && data.text.trim()) {
      // Send transcribed text back to background
      chrome.runtime.sendMessage({
        type: 'AUDIO_TRANSCRIBED',
        text: data.text,
        language: data.language,
        duration: data.duration
      });
      
      console.log(`[Offscreen] Transcribed (${data.language}): ${data.text.substring(0, 80)}...`);
    }
  } catch (err) {
    console.error('[Offscreen] Transcription failed:', err);
  }
}

/**
 * Stop capturing audio
 */
function stopCapture() {
  if (recordingInterval) {
    clearInterval(recordingInterval);
    recordingInterval = null;
  }
  
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
  mediaRecorder = null;
  
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
    audioStream = null;
  }
  
  console.log('[Offscreen] Capture stopped');
}
