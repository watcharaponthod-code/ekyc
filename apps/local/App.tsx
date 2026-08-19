/**
 * eKYC Local — 100 % on-device liveness, light edition.
 *
 * No network for the liveness itself: ML Kit drives turn left / turn right /
 * open mouth / move closer / move farther as movements from the person's own
 * neutral pose, with a face-continuity check across the run. No model, no
 * image processing — the verdict is ready when the last step completes.
 *
 * The one optional network call is the developer log sender at the bottom of
 * the home screen (numbers only, to a receiver on your own LAN).
 */

import { useCallback, useEffect, useState } from 'react'
import { Alert, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, TextInput, View } from 'react-native'
import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { IntroView, defaultTheme, type EKYCTheme } from '@ekyc/react-native-ekyc'
import { LocalLivenessCamera, type LocalResult } from '@ekyc/react-native-ekyc-local'

/** Bumped per published APK so a phone can prove which build it runs. */
const APP_BUILD = 11

/** Light theme — deliberately the opposite of the server demo's dark one. */
const theme: EKYCTheme = {
  ...defaultTheme,
  colors: {
    background: '#F4F6FA',
    scrim: 'rgba(244, 246, 250, 0.90)',
    surface: '#FFFFFF',
    accent: '#1D4ED8',
    accentSoft: 'rgba(29, 78, 216, 0.16)',
    success: '#15803D',
    danger: '#DC2626',
    text: '#0F172A',
    textDim: 'rgba(15, 23, 42, 0.62)',
    ovalIdle: 'rgba(15, 23, 42, 0.30)',
    onAccent: '#FFFFFF',
  },
}

/** One JSON line per session — numbers only, no images. This is what tuning reads. */
const LOG_FILE = new File(Paths.document, 'ekyc-local-sessions.jsonl')
/** Developer-only: where to POST the log over the LAN (`scripts/log_receiver.py` prints it). Empty = off. */
const RECEIVER_FILE = new File(Paths.document, 'ekyc-local-receiver.txt')

function appendLog(line: string): void {
  try {
    const previous = LOG_FILE.exists ? LOG_FILE.textSync() : ''
    LOG_FILE.write(previous + line + '\n')
  } catch {
    /* logging must never break the flow */
  }
}

function loadReceiver(): string {
  try {
    return RECEIVER_FILE.exists ? RECEIVER_FILE.textSync().trim() : ''
  } catch {
    return ''
  }
}

async function sendLog(url: string): Promise<string> {
  if (!LOG_FILE.exists) throw new Error('ยังไม่มี log')
  const base = url.replace(/\/+$/, '')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8000)
  try {
    const res = await fetch(`${base}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-ndjson' },
      body: LOG_FILE.textSync(),
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const body = (await res.json()) as { added?: number; sessions?: number }
    return `ส่งแล้ว: ใหม่ ${body.added ?? '?'} รอบ (คอมมีทั้งหมด ${body.sessions ?? '?'} รอบ)`
  } finally {
    clearTimeout(timer)
  }
}

type Screen = { kind: 'home' } | { kind: 'intro' } | { kind: 'capture' }

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'home' })
  const [last, setLast] = useState<LocalResult | null>(null)
  const [runs, setRuns] = useState<{ total: number; passed: number }>({ total: 0, passed: 0 })
  const [receiver, setReceiver] = useState<string>(() => loadReceiver())
  const [autoSend, setAutoSend] = useState(true)
  const [sendState, setSendState] = useState<string>('')

  useEffect(() => {
    try {
      RECEIVER_FILE.write(receiver)
    } catch {
      /* ignore */
    }
  }, [receiver])

  const handleResult = useCallback(
    (result: LocalResult) => {
      setLast(result)
      setRuns((r) => ({ total: r.total + 1, passed: r.passed + (result.passed ? 1 : 0) }))
      appendLog(JSON.stringify({ mode: 'check', build: APP_BUILD, ...result.report }))
      if (autoSend && receiver.trim()) {
        sendLog(receiver.trim())
          .then(setSendState)
          .catch((e: Error) => setSendState(`ส่งไม่สำเร็จ: ${e.message}`))
      }
    },
    [autoSend, receiver],
  )

  if (screen.kind === 'intro') {
    return (
      <IntroView
        locale="th"
        theme={theme}
        steps={['อยู่ในที่ที่มีแสงพอ และถอดแว่นกันแดด', 'จัดใบหน้าให้อยู่ในกรอบวงรี มองตรง', 'ทำตามคำสั่งทีละท่า แล้วมองจอนิ่งๆ ตอนจอกะพริบสี']}
        consent="ประมวลผลบนเครื่องทั้งหมด ไม่มีการส่งภาพหรือข้อมูลใบหน้าออกจากโทรศัพท์"
        onStart={() => setScreen({ kind: 'capture' })}
        onCancel={() => setScreen({ kind: 'home' })}
      />
    )
  }

  if (screen.kind === 'capture') {
    return <LocalLivenessCamera locale="th" theme={theme} debug onResult={handleResult} onCancel={() => setScreen({ kind: 'home' })} />
  }

  const c = last?.continuity
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>eKYC Local</Text>
        <Text style={styles.meta}>{`ทำงานบนเครื่องล้วน ไม่มีเซิร์ฟเวอร์ ไม่มีโมเดล · build ${APP_BUILD}`}</Text>

        <Text style={styles.label}>ทดสอบ liveness</Text>
        <Text style={styles.body}>คำสั่งแบบเดียวกับตัวเซิร์ฟเวอร์: อ้าปาก (ทุกครั้ง) + สุ่ม 3 จาก กระพริบตา · หันซ้าย · หันขวา · ขยับเข้า · ขยับออก (ทุกท่าเป็นการเคลื่อนไหวจากท่ามองตรง กลับมามองตรงระหว่างท่า) → จบด้วยแสงสีจากหน้าจอ 4 สี (กันรูป/จอ) + ตรวจว่าใบหน้าอยู่ต่อเนื่องตลอดรอบ</Text>
        <Button label="เริ่มสแกน" onPress={() => setScreen({ kind: 'intro' })} />
        {runs.total > 0 ? <Text style={styles.meta}>{`รอบนี้เปิดแอป: ผ่าน ${runs.passed} / ${runs.total}`}</Text> : null}

        {last ? (
          <View style={styles.card}>
            <Text style={styles.label}>ผลล่าสุด</Text>
            <Text style={[styles.body, { color: last.passed ? theme.colors.success : theme.colors.danger, fontWeight: '700' }]}>
              {last.passed ? 'ผ่าน' : `ไม่ผ่าน: ${last.reasons.join(', ')}`}
            </Text>
            <Text style={styles.mono}>
              {`ลำดับท่า: ${last.challenges.join(' → ')}\n` +
                `เวลา ${(last.timings.captureMs / 1000).toFixed(1)} วินาที\n` +
                (c
                  ? `ใบหน้าต่อเนื่อง: ${c.ok ? 'ใช่' : 'ไม่'} (หลุดนานสุด ${c.maxGapMs} ms, กระโดดมากสุด ${(c.maxJump * 100).toFixed(0)}%, ${c.faceFrames}/${c.frames} เฟรม) · advisory\n`
                  : '') +
                (last.flash
                  ? `แสงจอสะท้อน (กันรูป/จอ): ${last.flash.note ? `วัดไม่ได้ (${last.flash.note})` : `${last.flash.ok ? 'ผ่าน' : 'ต่ำ'} score ${last.flash.score.toFixed(2)} [${last.flash.colours.join(',')}]`} · advisory\n`
                  : '') +
                (Object.keys(last.report.stepMetrics).length
                  ? `ขั้นตอน (ทำได้ / ต้องการ):\n` +
                    Object.values(last.report.stepMetrics)
                      .map((m) => `  ${m.challenge}${m.phase ? ` (ช่วงที่ ${m.phase + 1})` : ''}: ${m.best.toFixed(2)} ${m.direction === 'above' ? '≥' : '≤'} ${m.needed.toFixed(2)}`)
                      .join('\n')
                  : '')}
            </Text>
          </View>
        ) : null}

        <Text style={styles.label}>ส่ง log ไปคอมผ่าน Wi-Fi (สำหรับปรับเกณฑ์)</Text>
        <Text style={styles.body}>รัน `python packages/react-native-ekyc-local/scripts/log_receiver.py` บนคอม แล้วพิมพ์ที่อยู่ที่มันบอก — ส่งเฉพาะตัวเลข ไม่มีรูป</Text>
        <TextInput
          style={styles.input}
          value={receiver}
          onChangeText={setReceiver}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder="http://192.168.1.20:8765"
          placeholderTextColor={theme.colors.textDim}
        />
        <Button
          label="ส่ง log ไปคอมตอนนี้"
          onPress={() => {
            const url = receiver.trim()
            if (!url) {
              Alert.alert('ยังไม่ได้ใส่ที่อยู่คอม', 'พิมพ์ที่อยู่ที่ log_receiver.py แสดง เช่น http://192.168.1.20:8765')
              return
            }
            setSendState('กำลังส่ง…')
            sendLog(url)
              .then(setSendState)
              .catch((e: Error) => setSendState(`ส่งไม่สำเร็จ: ${e.message} — เช็คว่า receiver รันอยู่และอยู่ Wi-Fi เดียวกัน`))
          }}
        />
        <Button label={autoSend ? 'ส่งอัตโนมัติหลังทุกรอบ: เปิด' : 'ส่งอัตโนมัติหลังทุกรอบ: ปิด'} variant="ghost" onPress={() => setAutoSend((v) => !v)} />
        {sendState ? <Text style={styles.meta}>{sendState}</Text> : null}
        <Button
          label="แชร์ไฟล์ log"
          variant="ghost"
          onPress={() => {
            void (async () => {
              try {
                if (!LOG_FILE.exists) {
                  Alert.alert('ยังไม่มี log', 'สแกนสักครั้งก่อน')
                  return
                }
                if (!(await Sharing.isAvailableAsync())) {
                  Alert.alert('แชร์ไม่ได้บนเครื่องนี้', LOG_FILE.uri)
                  return
                }
                await Sharing.shareAsync(LOG_FILE.uri, { mimeType: 'application/json', dialogTitle: 'eKYC Local session log' })
              } catch (e) {
                Alert.alert('แชร์ไม่สำเร็จ', (e as Error).message)
              }
            })()
          }}
        />
        <Button
          label="ล้าง log"
          variant="ghost"
          onPress={() => {
            try {
              if (LOG_FILE.exists) LOG_FILE.delete()
            } catch {
              /* already gone */
            }
            Alert.alert('ล้างแล้ว', 'log ถูกลบแล้ว')
          }}
        />

        <Text style={styles.footnote}>
          ตัวนี้พิสูจน์ว่า “มีคนอยู่หน้ากล้องและทำท่าตามคำสั่งจริงต่อเนื่องทั้งรอบ” + แสงจอสะท้อนบนใบหน้า (กันรูปถ่าย/จอ — ไม่ใช่หน้ากาก) — ไม่มีการจดจำว่าเป็นใคร (ระบบที่เชื่อมเซิร์ฟเวอร์มีชั้น PAD/identity เต็ม)
        </Text>
      </ScrollView>
    </SafeAreaView>
  )
}

function Button({ label, onPress, variant = 'solid' }: { label: string; onPress: () => void; variant?: 'solid' | 'ghost' }) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.button, variant === 'solid' ? { backgroundColor: theme.colors.accent } : { borderColor: theme.colors.accent, borderWidth: 1 }]}
    >
      <Text style={[styles.buttonText, variant === 'solid' ? { color: theme.colors.onAccent ?? '#0A0E1A' } : { color: theme.colors.accent }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 24, gap: 12, paddingBottom: 48 },
  title: { color: theme.colors.text, fontSize: 28, fontWeight: '800', marginTop: 12 },
  label: { color: theme.colors.text, fontSize: 15, fontWeight: '700', marginTop: 16 },
  body: { color: theme.colors.textDim, fontSize: 14, lineHeight: 20 },
  meta: { color: theme.colors.textDim, fontSize: 12 },
  mono: { color: theme.colors.text, fontSize: 12, fontVariant: ['tabular-nums'], lineHeight: 18 },
  card: { backgroundColor: theme.colors.surface, borderRadius: 14, padding: 14, marginTop: 8 },
  footnote: { color: theme.colors.textDim, fontSize: 12, lineHeight: 18, marginTop: 24 },
  button: { height: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16 },
  input: { height: 48, borderRadius: 12, paddingHorizontal: 14, backgroundColor: theme.colors.surface, color: theme.colors.text, fontSize: 15, borderWidth: 1, borderColor: 'rgba(15, 23, 42, 0.15)' },
  buttonText: { fontSize: 15, fontWeight: '700' },
})
