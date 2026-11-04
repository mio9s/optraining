// 生成ファイル(scripts/import-glass.mjs)。手で編集しないこと。
// 出典: refractiveindex.info-database https://github.com/polyanskiy/refractiveindex.info-database
//       commit c5c2f188e848453def5970e347399d653df2ffc2
// ライセンス: CC0 1.0 (public domain)
// Sellmeier: n² = 1 + Σ Bᵢ λ² / (λ² − Cᵢ)   (λ: µm, Cᵢ: µm²)
export const GLASS_SOURCE_SHA = 'c5c2f188e848453def5970e347399d653df2ffc2';
export const GLASS = {
  "N-BK7": {
    "B": [
      1.03961212,
      0.231792344,
      1.01046945
    ],
    "C": [
      0.00600069867,
      0.0200179144,
      103.560653
    ],
    "source": "specs/schott/optical/N-BK7.yml"
  },
  "N-SF11": {
    "B": [
      1.73759695,
      0.313747346,
      1.89878101
    ],
    "C": [
      0.013188707,
      0.0623068142,
      155.23629
    ],
    "source": "specs/schott/optical/N-SF11.yml"
  },
  "N-SF5": {
    "B": [
      1.52481889,
      0.187085527,
      1.42729015
    ],
    "C": [
      0.011254756,
      0.0588995392,
      129.141675
    ],
    "source": "specs/schott/optical/N-SF5.yml"
  },
  "N-SK16": {
    "B": [
      1.34317774,
      0.241144399,
      0.994317969
    ],
    "C": [
      0.00704687339,
      0.0229005,
      92.7508526
    ],
    "source": "specs/schott/optical/N-SK16.yml"
  },
  "N-F2": {
    "B": [
      1.39757037,
      0.159201403,
      1.2686543
    ],
    "C": [
      0.00995906143,
      0.0546931752,
      119.248346
    ],
    "source": "specs/schott/optical/N-F2.yml"
  },
  "N-LAK9": {
    "B": [
      1.46231905,
      0.344399589,
      1.15508372
    ],
    "C": [
      0.00724270156,
      0.0243353131,
      85.4686868
    ],
    "source": "specs/schott/optical/N-LAK9.yml"
  },
  "N-BAF10": {
    "B": [
      1.5851495,
      0.143559385,
      1.08521269
    ],
    "C": [
      0.00926681282,
      0.0424489805,
      105.613573
    ],
    "source": "specs/schott/optical/N-BAF10.yml"
  },
  "Fused Silica": {
    "B": [
      0.6961663,
      0.4079426,
      0.8974794
    ],
    "C": [
      0.00467914825849,
      0.013512063073959999,
      97.93400253792099
    ],
    "source": "main/SiO2/nk/Malitson.yml"
  }
};
