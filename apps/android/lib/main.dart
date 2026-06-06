import 'package:flutter/material.dart';

/// Audiobook Companion — the native listening client (plan 188). This is the
/// app-1 shell; pairing (app-2), the library, and the player land on top of it.
void main() {
  runApp(const AudiobookCompanionApp());
}

class AudiobookCompanionApp extends StatelessWidget {
  const AudiobookCompanionApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Audiobook Companion',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF8A2BE2)),
        useMaterial3: true,
      ),
      home: const HomePage(),
    );
  }
}

class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Audiobook Companion')),
      body: const Center(
        // app-2 replaces this with the pair-to-server flow.
        child: Text('Not paired yet', key: Key('home-status')),
      ),
    );
  }
}
