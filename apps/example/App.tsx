/**
 * Demo of `@ekyc/react-native-ekyc`.
 *
 * Deliberately plain: everything visually interesting belongs to the module,
 * and this file exists to show how little a host app has to do.
 *
 * Flow: home → intro → capture → result → home.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import {
  EKYCCamera,
  EKYCClient,
  IntroView,
  defaultTheme,
  type Decision,
  type Person,
  type Purpose,
} from '@ekyc/react-native-ekyc'

/**
 * Point this at your server.
 *
 * `localhost` is the phone itself, so on a physical device use your machine's
 * LAN address. It is editable on the home screen so you do not have to rebuild.
 */
const DEFAULT_BASE_URL = 'http://192.168.1.177:8000'
/** Bumped per published APK so a phone can prove which build it runs. */
const APP_BUILD = 15

type Screen =
  | { kind: 'home' }
  | { kind: 'intro'; purpose: Purpose; personId?: string; name?: string }
  | { kind: 'capture'; purpose: Purpose; personId?: string; name?: string }

const theme = defaultTheme

export default function App() {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL)
  const [screen, setScreen] = useState<Screen>({ kind: 'home' })
  const [people, setPeople] = useState<Person[]>([])
  const [health, setHealth] = useState<string>('…')
  const [busy, setBusy] = useState(false)
  const [name, setName] = useState('')

  const client = useMemo(() => new EKYCClient({ baseUrl }), [baseUrl])

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const [status, list] = await Promise.all([client.health(), client.listPersons()])
      setHealth(`${status.status} · ${status.version}`)
      setPeople(list)
    } catch (error) {
      setHealth(`unreachable — ${(error as Error).message}`)
      setPeople([])
    } finally {
      setBusy(false)
    }
  }, [client])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleResult = useCallback(
    (decision: Decision) => {
      if (decision.decision === 'pass') void refresh()
    },
    [refresh],
  )

  if (screen.kind === 'intro') {
    return (
      <IntroView
        locale="th"
        theme={theme}
        onStart={() => setScreen({ ...screen, kind: 'capture' })}
        onCancel={() => setScreen({ kind: 'home' })}
      />
    )
  }

  if (screen.kind === 'capture') {
    return (
      <EKYCCamera
        client={client}
        purpose={screen.purpose}
        personId={screen.personId}
        displayName={screen.name}
        locale="th"
        theme={theme}
        onResult={handleResult}
        onCancel={() => setScreen({ kind: 'home' })}
        // Live yaw/eye numbers + recent log on screen: the diagnostic the QA
        // checklist asks for, and what a phone with no cable can still show.
        debug
      />
    )
  }

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.title}>eKYC demo</Text>

        <Text style={styles.label}>Server</Text>
        <TextInput
          style={styles.input}
          value={baseUrl}
          onChangeText={setBaseUrl}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder="http://192.168.1.10:8000"
          placeholderTextColor={theme.colors.textDim}
        />
        <View style={styles.row}>
          <Text style={styles.meta}>{`${health} · app b${APP_BUILD}`}</Text>
          {busy ? <ActivityIndicator color={theme.colors.accent} /> : null}
        </View>

        <Text style={styles.label}>ลงทะเบียนใหม่ (enroll)</Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={setName}
          placeholder="ชื่อ-นามสกุล"
          placeholderTextColor={theme.colors.textDim}
        />
        <Button
          label="สแกนใบหน้าเพื่อลงทะเบียน"
          onPress={() =>
            setScreen({ kind: 'intro', purpose: 'enroll', name: name.trim() || 'ไม่ระบุชื่อ' })
          }
        />

        <Button
          label="ค้นหาว่าเป็นใคร (identify 1:N)"
          variant="ghost"
          onPress={() => setScreen({ kind: 'intro', purpose: 'identify' })}
        />

        <Text style={styles.label}>ผู้ที่ลงทะเบียนแล้ว ({people.length})</Text>
        {people.length === 0 ? (
          <Text style={styles.meta}>ยังไม่มีใครลงทะเบียน</Text>
        ) : (
          people.map((person) => (
            <View key={person.id} style={styles.card}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardTitle}>{person.displayName ?? person.id}</Text>
                <Text style={styles.meta}>
                  {person.templateCount} template · {person.id.slice(0, 12)}…
                </Text>
              </View>
              <Pressable
                style={styles.smallButton}
                onPress={() =>
                  setScreen({ kind: 'intro', purpose: 'verify', personId: person.id })
                }
              >
                <Text style={styles.smallButtonText}>verify</Text>
              </Pressable>
              <Pressable
                style={[styles.smallButton, styles.dangerButton]}
                onPress={() =>
                  Alert.alert('ลบข้อมูลใบหน้า?', person.displayName ?? person.id, [
                    { text: 'ยกเลิก', style: 'cancel' },
                    {
                      text: 'ลบ',
                      style: 'destructive',
                      onPress: async () => {
                        await client.deletePerson(person.id)
                        void refresh()
                      },
                    },
                  ])
                }
              >
                <Text style={styles.smallButtonText}>ลบ</Text>
              </Pressable>
            </View>
          ))
        )}

        <Button label="รีเฟรช" variant="ghost" onPress={() => void refresh()} />
      </ScrollView>
    </SafeAreaView>
  )
}

function Button({
  label,
  onPress,
  variant = 'primary',
}: {
  label: string
  onPress: () => void
  variant?: 'primary' | 'ghost'
}) {
  const ghost = variant === 'ghost'
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        ghost && styles.buttonGhost,
        { opacity: pressed ? 0.8 : 1 },
      ]}
    >
      <Text style={[styles.buttonText, ghost && { color: theme.colors.accent }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.colors.background },
  content: { padding: 20, gap: 10, paddingBottom: 60 },
  title: { color: theme.colors.text, fontSize: 26, fontWeight: '700', marginBottom: 4 },
  label: { color: theme.colors.textDim, fontSize: 13, marginTop: 18, fontWeight: '600' },
  meta: { color: theme.colors.textDim, fontSize: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  input: {
    backgroundColor: theme.colors.surface,
    color: theme.colors.text,
    borderRadius: 12,
    paddingHorizontal: 14,
    height: 46,
    fontSize: 15,
  },
  button: {
    backgroundColor: theme.colors.accent,
    height: 50,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
  },
  buttonGhost: { backgroundColor: 'transparent' },
  buttonText: { color: '#0A0E1A', fontSize: 16, fontWeight: '700' },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: theme.colors.surface,
    borderRadius: 14,
    padding: 14,
  },
  cardTitle: { color: theme.colors.text, fontSize: 15, fontWeight: '600' },
  smallButton: {
    backgroundColor: theme.colors.accentSoft,
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 10,
    justifyContent: 'center',
  },
  dangerButton: { backgroundColor: 'rgba(251, 113, 133, 0.18)' },
  smallButtonText: { color: theme.colors.text, fontSize: 13, fontWeight: '600' },
})
