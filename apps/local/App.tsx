/**
 * eKYC Local — 100 % on-device liveness + identity.
 *
 * Nothing here talks to a network. ML Kit runs the turn / open-mouth / nod
 * coaching, MobileFaceNet (TFLite) embeds each captured pose, and the app
 * checks every frame is the same person. A saved face ("enrol") lives in the
 * app's private storage as a 192-number template — never as an image.
 *
 * Flow: home → capture → result → home.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Text, View } from 'react-native'
import { File, Paths } from 'expo-file-system'
import * as Sharing from 'expo-sharing'
import { IntroView, defaultTheme, type EKYCTheme } from '@ekyc/react-native-ekyc'
import {
  DEFAULT_CONSISTENCY_MIN,
  DEFAULT_MATCH_MIN,
  FaceEmbedder,
  LocalLivenessCamera,
  embeddingFromJson,
  embeddingToJson,
  type LocalResult,
} from '@ekyc/react-native-ekyc-local'

/** Bumped per published APK so a phone can prove which build it runs. */
const APP_BUILD = 6

/**
 * Light theme — deliberately the opposite of the server demo's dark one, so
 * the two apps are never mistaken for each other on a phone. Same geometry
 * and typography as `defaultTheme`; only the palette changes.
 */
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
const TEMPLATE_FILE = new File(Paths.document, 'ekyc-local-template.json')
/** One JSON line per session — numbers only, no images or embeddings. This is what tuning reads. */
const LOG_FILE = new File(Paths.document, 'ekyc-local-sessions.jsonl')

function appendLog(line: string): void {
  try {
    const previous = LOG_FILE.exists ? LOG_FILE.textSync() : ''
    LOG_FILE.write(previous + line + '\n')
  } catch {
    /* logging must never break the flow */
  }
}

type Mode = 'check' | 'enroll' | 'verify'
type Screen = { kind: 'home' } | { kind: 'intro'; mode: Mode } | { kind: 'capture'; mode: Mode }

function loadTemplate(): Float32Array | null {
  try {
    if (!TEMPLATE_FILE.exists) return null
    return embeddingFromJson(TEMPLATE_FILE.textSync())
  } catch {
    return null
  }
}

export default function App() {
  const [screen, setScreen] = useState<Screen>({ kind: 'home' })
  const [template, setTemplate] = useState<Float32Array | null>(() => loadTemplate())
  const [last, setLast] = useState<{ mode: Mode; result: LocalResult } | null>(null)
  const embedder = useMemo(() => new FaceEmbedder(), [])
  const [modelState, setModelState] = useState('loading model…')

  useEffect(() => {
    embedder
      .load()
      .then((m) => setModelState(`MobileFaceNet ready · in ${JSON.stringify(m.inputs[0]?.shape)} → ${JSON.stringify(m.outputs[0]?.shape)}`))
      .catch((e: Error) => setModelState(`model failed: ${e.message}`))
  }, [embedder])

  const handleResult = useCallback(
    (mode: Mode, result: LocalResult) => {
      setLast({ mode, result })
      appendLog(JSON.stringify({ mode, ...result.report }))
      if (mode === 'enroll' && result.passed && result.embedding) {
        try {
          TEMPLATE_FILE.write(embeddingToJson(result.embedding))
          setTemplate(result.embedding)
        } catch (e) {
          Alert.alert('บันทึกไม่สำเร็จ', (e as Error).message)
        }
      }
    },
    [],
  )

  if (screen.kind === 'intro') {
    return (
      <IntroView
        locale="th"
        theme={theme}
        steps={['อยู่ในที่ที่มีแสงพอ และถอดแว่นกันแดด', 'จัดใบหน้าให้อยู่ในกรอบวงรี มองตรง', 'ทำตามคำสั่ง: หันซ้าย หันขวา อ้าปาก พยักหน้า แล้วอยู่นิ่ง 7 วินาที']}
        consent="ประมวลผลบนเครื่องทั้งหมด ไม่มีการส่งภาพหรือข้อมูลใบหน้าออกจากโทรศัพท์"
        onStart={() => setScreen({ kind: 'capture', mode: screen.mode })}
        onCancel={() => setScreen({ kind: 'home' })}
      />
    )
  }

  if (screen.kind === 'capture') {
    return (
      <LocalLivenessCamera
        embedder={embedder}
        reference={screen.mode === 'verify' ? template : null}
        locale="th"
        theme={theme}
        debug
        onResult={(r) => handleResult(screen.mode, r)}
        onCancel={() => setScreen({ kind: 'home' })}
      />
    )
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>eKYC Local</Text>
        <Text style={styles.meta}>{`ทำงานบนเครื่องล้วน ไม่มีเซิร์ฟเวอร์ · build ${APP_BUILD}`}</Text>
        <Text style={styles.meta}>{modelState}</Text>

        <Text style={styles.label}>ทดสอบ liveness</Text>
        <Text style={styles.body}>หันซ้าย · หันขวา · อ้าปากแล้วหุบ · เงยแล้วก้ม (สุ่มลำดับ กลับมามองตรงระหว่างท่า) → อยู่นิ่ง 7 วิ วัดชีพจรจากสีผิว (rPPG) → เช็คว่าทุกภาพเป็นคนเดียวกันด้วย MobileFaceNet</Text>
        <Button label="เริ่มสแกน (เช็คความสอดคล้องอย่างเดียว)" onPress={() => setScreen({ kind: 'intro', mode: 'check' })} />

        <Text style={styles.label}>จดจำใบหน้าในเครื่อง</Text>
        <Text style={styles.body}>
          {template ? 'มีใบหน้าที่บันทึกไว้แล้ว 1 คน (เก็บเป็นตัวเลข 192 ค่า ไม่ใช่รูป)' : 'ยังไม่มีใบหน้าที่บันทึกไว้'}
        </Text>
        <Button label={template ? 'บันทึกใบหน้าใหม่ (แทนที่)' : 'บันทึกใบหน้าฉัน (enroll)'} onPress={() => setScreen({ kind: 'intro', mode: 'enroll' })} />
        <Button
          label="ยืนยันว่าเป็นคนที่บันทึกไว้ (verify)"
          variant="ghost"
          onPress={() => {
            if (!template) {
              Alert.alert('ยังไม่มีข้อมูล', 'บันทึกใบหน้าก่อน แล้วค่อยยืนยัน')
              return
            }
            setScreen({ kind: 'intro', mode: 'verify' })
          }}
        />
        {template ? (
          <Button
            label="ลบใบหน้าที่บันทึกไว้"
            variant="ghost"
            onPress={() => {
              try {
                if (TEMPLATE_FILE.exists) TEMPLATE_FILE.delete()
              } catch {
                /* already gone */
              }
              setTemplate(null)
            }}
          />
        ) : null}

        {last ? (
          <View style={styles.card}>
            <Text style={styles.label}>ผลล่าสุด · {last.mode}</Text>
            <Text style={[styles.body, { color: last.result.passed ? theme.colors.success : theme.colors.danger, fontWeight: '700' }]}>
              {last.result.passed ? 'ผ่าน' : `ไม่ผ่าน: ${last.result.reasons.join(', ')}`}
            </Text>
            <Text style={styles.mono}>
              {`challenges: ${last.result.challenges.join(' → ')}\n` +
                `consistency min: ${last.result.consistency.min.toFixed(3)} (≥ ${DEFAULT_CONSISTENCY_MIN})` +
                (last.result.consistency.weakest ? `  weakest ${last.result.consistency.weakest.join('↔')}` : '') +
                `\n` +
                last.result.consistency.pairs.map((p) => `  ${p.a} ↔ ${p.b}: ${p.similarity.toFixed(3)}`).join('\n') +
                (last.result.match ? `\nmatch vs saved: ${last.result.match.score.toFixed(3)} (≥ ${DEFAULT_MATCH_MIN}) ${last.result.match.ok ? 'ok' : 'NO'}` : '') +
                `\ncapture ${last.result.timings.captureMs} ms · embed ${last.result.timings.embedMs} ms · frames ${last.result.frames.length}` +
                (Object.keys(last.result.report.stepMetrics).length
                  ? `\nขั้นตอน (ทำได้ / ต้องการ):\n` +
                    Object.values(last.result.report.stepMetrics)
                      .map((m) => `  ${m.challenge}${m.phase ? ` (ช่วงที่ ${m.phase + 1})` : ''}: ${m.best.toFixed(2)} ${m.direction === 'above' ? '≥' : '≤'} ${m.needed.toFixed(2)}`)
                      .join('\n')
                  : '')}
            </Text>
          </View>
        ) : null}

        <Text style={styles.label}>บันทึกการทดสอบ (log)</Text>
        <Text style={styles.body}>ทุกครั้งที่สแกน แอปจะบันทึกตัวเลขของรอบนั้น (ไม่มีรูป ไม่มีข้อมูลใบหน้า) ส่งไฟล์นี้มาเพื่อปรับเกณฑ์ให้ตรงกับเครื่องจริง</Text>
        <Button
          label="แชร์ log การทดสอบ"
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
          ตัวนี้พิสูจน์ว่า “คนที่ทำท่าทั้งหมดเป็นคนเดียวกัน” (และถ้าเลือก verify ตรงกับที่บันทึกไว้) · หน้ากากแข็งอ้าปากไม่ได้จึงไม่ผ่านขั้นอ้าปาก · ชีพจร rPPG จับหน้ากากซิลิโคน (ยังเป็น advisory จนกว่าจะวัดบนมือถือจริง) · ยังไม่มีการตรวจภาพถ่าย/จอบนเครื่อง
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
  buttonText: { fontSize: 15, fontWeight: '700' },
})
