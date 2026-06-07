package ai.castwright

import com.ryanheise.audioservice.AudioServiceActivity

// app-5: extend AudioServiceActivity so audio_service's media session (lock
// screen, Bluetooth controls, notification) attaches to the Flutter engine.
class MainActivity : AudioServiceActivity()
