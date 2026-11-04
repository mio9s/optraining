# 第三者ライブラリとの光線追跡比較(rayoptics)

`test/fixtures/rayoptics-reference.json` の再生成手順(通常は不要)。

```sh
python3 -m venv venv && ./venv/bin/pip install rayoptics==0.9.10
node scripts/verify/export_cases.mjs spec.json ours.json
# opticalglass は import 時に refractiveindex.info DB を取りに行くため、空の DB を指定する
mkdir -p fake-rii/data && echo "[]" > fake-rii/catalog-nk.yml
refractiveindexinfodb=$PWD/fake-rii ./venv/bin/python -I scripts/verify/rayoptics_trace.py spec.json ro.json ours.json
```

屈折率は本実装の値を `ConstantIndex` で与え、純粋に幾何学的な追跡(交点・屈折・光路長)を比較する。
