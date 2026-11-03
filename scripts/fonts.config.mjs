/**
 * Sources for the bundled fonts. Versions are pinned so a rebuild is
 * reproducible; the generated woff2 files are committed, so a normal install
 * never touches the network or Python.
 */
export const SOURCES = [
  {
    name: "LXGWWenKai-Regular.ttf",
    url: "https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/LXGWWenKai-Regular.ttf",
    bytes: 25928940,
    sha256: "",
  },
  {
    name: "NotoSerifSC.ttf",
    url: "https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notoserifsc/NotoSerifSC%5Bwght%5D.ttf",
    bytes: 25125512,
    sha256: "",
  },
  {
    name: "NotoSansSC.ttf",
    url: "https://raw.githubusercontent.com/google/fonts/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf",
    bytes: 17772300,
    sha256: "",
  },
];

export const LICENSES = {
  wenkai: {
    name: "SIL Open Font License 1.1",
    url: "https://raw.githubusercontent.com/lxgw/LxgwWenKai/v1.530/OFL.txt",
    file: "LICENSE-wenkai.txt",
  },
  serif: {
    name: "SIL Open Font License 1.1",
    url: "https://raw.githubusercontent.com/google/fonts/8b0a1d0f5983c89bc2b93f1b5fb55f9e252744b5/ofl/notoserifsc/OFL.txt",
    file: "LICENSE-noto-serif-sc.txt",
  },
  sans: {
    name: "SIL Open Font License 1.1",
    url: "https://raw.githubusercontent.com/google/fonts/a85815a42757630ce188fdad368c2dfc444d4773/ofl/notosanssc/OFL.txt",
    file: "LICENSE-noto-sans-sc.txt",
  },
};

/** One row per selectable font. `fallback` is the stack after our family. */
export const FONTS = [
  {
    id: "wenkai",
    family: "DWP WenKai",
    labels: { zh: "霞鹜文楷", en: "LXGW WenKai" },
    sample: "永和九年，岁在癸丑。文楷手写 Aa 123",
    previewText: "永和九年 文楷 Aa 123",
    fallback: '"Kaiti SC", "STKaiti", "PingFang SC", sans-serif',
    source: "LXGWWenKai-Regular.ttf",
    variable: null,
    file: "wenkai.woff2",
    previewFile: "wenkai-preview.woff2",
    license: "wenkai",
  },
  {
    id: "serif",
    family: "DWP Noto Serif SC",
    labels: { zh: "思源宋体", en: "Noto Serif SC" },
    sample: "山河远阔，人间烟火。宋体雅正 Aa 123",
    previewText: "山河远阔 宋体 Aa 123",
    fallback: '"Songti SC", "STSong", "Noto Serif CJK SC", serif',
    source: "NotoSerifSC.ttf",
    variable: "wght",
    file: "serif.woff2",
    previewFile: "serif-preview.woff2",
    license: "serif",
  },
  {
    id: "sans",
    family: "DWP Noto Sans SC",
    labels: { zh: "思源黑体", en: "Noto Sans SC" },
    sample: "清晰现代，删繁就简。黑体 Aa 123",
    previewText: "清晰现代 黑体 Aa 123",
    fallback: '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif',
    source: "NotoSansSC.ttf",
    variable: "wght",
    file: "sans.woff2",
    previewFile: "sans-preview.woff2",
    license: "sans",
  },
];
