/**
 * The face mesh — a tesselation of MediaPipe's 478 landmarks drawn over the
 * camera preview, so the person can see the system has locked onto their face
 * and is reading its geometry. Web only (react-native-web + SVG).
 *
 * This is the same landmark set the server measures pose and eye openness
 * from, so what you see is genuinely what gets judged.
 */

import { StyleSheet, View } from 'react-native'
import Svg, { Circle, Line } from 'react-native-svg'
import type { MeshPoint } from './useWebcamFace'

export function FaceMesh({
  points,
  connections,
  width,
  height,
  mirrored = true,
  color = '#6C8CFF',
}: {
  points: MeshPoint[]
  connections: Array<[number, number]>
  width: number
  height: number
  mirrored?: boolean
  color?: string
}) {
  if (points.length === 0) return null
  const px = (p: MeshPoint) => (mirrored ? (1 - p.x) * width : p.x * width)
  const py = (p: MeshPoint) => p.y * height

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={width} height={height}>
        {connections.map(([a, b], i) => {
          const pa = points[a]
          const pb = points[b]
          if (!pa || !pb) return null
          return (
            <Line
              key={i}
              x1={px(pa)} y1={py(pa)} x2={px(pb)} y2={py(pb)}
              stroke={color} strokeWidth={0.6} strokeOpacity={0.55}
            />
          )
        })}
        {points.map((p, i) => (
          <Circle key={i} cx={px(p)} cy={py(p)} r={1.2} fill={color} fillOpacity={0.9} />
        ))}
      </Svg>
    </View>
  )
}
