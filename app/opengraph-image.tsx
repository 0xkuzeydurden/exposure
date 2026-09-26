import { ImageResponse } from "next/og";

export const alt = "EXPOSURE · an x-ray for any token. Every chart shows you the price. EXPOSURE shows who's behind it. Powered by Nansen API.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// A stylised 7-day price line (the "bone" on the film), 0..1 from the bottom.
const LINE = [0.3, 0.33, 0.31, 0.36, 0.35, 0.4, 0.44, 0.62, 0.78, 0.74, 0.7, 0.64, 0.6, 0.55, 0.57, 0.52, 0.5, 0.54, 0.58, 0.56, 0.6];
const BANDS = [
  { y: 0.82, h: 0.06, a: 0.34 },
  { y: 0.66, h: 0.1, a: 0.42 },
  { y: 0.2, h: 0.1, a: 0.2 },
];

export default function OpengraphImage() {
  const W = 700;
  const H = 360;
  const pts = LINE.map((v, i) => `${((i / (LINE.length - 1)) * W).toFixed(1)},${((1 - v) * H).toFixed(1)}`).join(" ");
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", background: "#05080b", color: "#e9f2f9", position: "relative" }}>
        {/* signage */}
        <div
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            top: 0,
            height: 78,
            display: "flex",
            alignItems: "center",
            padding: "0 48px",
            background: "#0e151c",
            borderTop: "5px solid #2d6a8a",
          }}
        >
          <div style={{ display: "flex", position: "relative", width: 30, height: 30, marginRight: 18 }}>
            <div style={{ position: "absolute", left: 11, top: 1, width: 8, height: 28, background: "#e9f2f9" }} />
            <div style={{ position: "absolute", left: 1, top: 11, width: 28, height: 8, background: "#e9f2f9" }} />
          </div>
          <div style={{ display: "flex", fontSize: 30, letterSpacing: 9, fontWeight: 600 }}>EXPOSURE</div>
          <div style={{ display: "flex", marginLeft: 22, fontSize: 18, letterSpacing: 4, color: "#8a9aa8" }}>RADIOLOGY · ON-CHAIN IMAGING</div>
        </div>

        {/* lightbox with the film */}
        <div
          style={{
            position: "absolute",
            left: 48,
            top: 118,
            width: 760,
            height: 440,
            display: "flex",
            padding: 30,
            background: "#0e1720",
            border: "8px solid #1b232b",
          }}
        >
          <div style={{ display: "flex", position: "relative", width: W, height: H, background: "#070b10" }}>
            {BANDS.map((b, i) => (
              <div
                key={i}
                style={{
                  position: "absolute",
                  left: 0,
                  right: 0,
                  top: (1 - b.y - b.h) * H,
                  height: b.h * H,
                  background: `rgba(219,233,245,${b.a})`,
                  display: "flex",
                }}
              />
            ))}
            <div style={{ position: "absolute", left: 0, right: 0, top: H * 0.52, height: 2, borderTop: "2px dashed rgba(233,242,249,0.7)", display: "flex" }} />
            <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", left: 0, top: 0 }}>
              <polyline points={pts} fill="none" stroke="#cfe6ff" strokeOpacity={0.3} strokeWidth={9} />
              <polyline points={pts} fill="none" stroke="#f2f8fd" strokeWidth={3} />
            </svg>
            <div
              style={{
                position: "absolute",
                left: 420,
                top: 40,
                display: "flex",
                padding: "6px 12px",
                border: "2px solid #ffb547",
                color: "#ffb547",
                fontSize: 20,
                background: "#0a0f14",
              }}
            >
              SELL WALL +22%
            </div>
          </div>
        </div>

        {/* the report */}
        <div
          style={{
            position: "absolute",
            right: 48,
            top: 118,
            width: 300,
            height: 440,
            display: "flex",
            flexDirection: "column",
            padding: "26px 22px",
            background: "#f4f1e8",
            color: "#1c1d22",
            border: "10px solid #3a2c20",
          }}
        >
          <div style={{ display: "flex", fontSize: 17, letterSpacing: 2, fontWeight: 700 }}>IMPRESSION</div>
          <div style={{ display: "flex", fontSize: 30, lineHeight: 1.2, marginTop: 16, fontWeight: 700 }}>
            Every chart shows you the price.
          </div>
          <div style={{ display: "flex", fontSize: 22, lineHeight: 1.3, marginTop: 14, color: "#1f3a8a" }}>EXPOSURE shows who&apos;s behind it.</div>
          {/* A double-ruled stamp (the image renderer has no `double` border style: two nested borders). */}
          <div
            style={{
              display: "flex",
              marginTop: "auto",
              alignSelf: "flex-end",
              border: "3px solid #c0322a",
              padding: 3,
              transform: "rotate(-9deg)",
            }}
          >
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                border: "1px solid #c0322a",
                color: "#c0322a",
                padding: "6px 12px",
                fontSize: 15,
                letterSpacing: 3,
              }}
            >
              <div style={{ display: "flex" }}>REVIEWED</div>
              <div style={{ display: "flex", fontSize: 19, fontWeight: 700 }}>POWERED BY NANSEN API</div>
            </div>
          </div>
        </div>
      </div>
    ),
    size,
  );
}
