// lib/ekyc_liveness.dart — Dart side of the bridge.
import 'dart:convert';
import 'package:flutter/services.dart';

class EkycLiveness {
  static const _ch = MethodChannel('ekyc_liveness');

  /// Runs the on-device liveness flow and returns the result map
  /// (`passed`, `reasons`, `steps`, `flashScore`, `continuityOk`, `durationMs`, `log`).
  /// [config] keys: challenges, challengeCount, locale, flash, flashRule,
  /// continuityRule, holdMs, showIntro, showResult, title — all optional.
  static Future<Map<String, dynamic>> start([Map<String, dynamic> config = const {}]) async {
    final json = await _ch.invokeMethod<String>('start', jsonEncode(config));
    return jsonDecode(json ?? '{"passed":false,"reasons":["LOCAL_cancelled"]}') as Map<String, dynamic>;
  }
}

// Usage:
//   final r = await EkycLiveness.start({'locale': 'th'});
//   if (r['passed'] == true) { ... }
