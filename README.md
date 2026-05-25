# S-57 Web Chart Viewer

대한민국 S-57 전자해도(ENC) 데이터를 웹 브라우저에서 조회하는 뷰어입니다.

**GitHub:** [https://github.com/ejavm83/s57viewer](https://github.com/ejavm83/s57viewer)

OpenCPN과 **동일한 S-52 심볼 번들**을 쓰려면 로컬에 OpenCPN을 설치한 뒤 `python scripts/sync_opencpn_s57data.py` → `python scripts/build_preslib.py` 순으로 실행하세요. 자세한 내용은 [DOCUMENTATION.md](DOCUMENTATION.md)의 **4.6절**(IHO S-52 Presentation Library)을 참고하세요.

## 요구 사항

- Python 3.10+
- GDAL (pyogrio 의존)
- 로컬 S-57 해도 데이터 경로 (`server.py`의 `S57_DIR`)

## 실행

```bash
pip install -r requirements.txt
python -m uvicorn server:app --reload --host 127.0.0.1 --port 8000
```

Windows에서는 `uvicorn` 명령이 PATH에 없을 수 있으므로 `python -m uvicorn`을 사용하거나 `run.bat`을 더블클릭하세요.

브라우저에서 `http://localhost:8000` 을 엽니다.

## 배포

이 앱은 **GDAL/pyogrio**와 **로컬 S-57 해도 파일**이 필요합니다. Vercel 단독 배포는 불가하며, 아래 조합을 권장합니다.

| 구성 | 역할 |
|------|------|
| [Render](https://render.com) (Docker) | FastAPI + S-57 데이터 처리 |
| [Vercel](https://vercel.com) | 정적 UI (`static/`), `/api`는 Render로 프록시 |

### 1. Render (백엔드)

1. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint** → GitHub `ejavm83/s57viewer` 연결
2. 배포 URL 예: `https://s57viewer.onrender.com`

**Free 플랜** (`render.yaml` 기본): Persistent Disk를 쓸 수 없습니다. Docker 이미지에는 `sample_data/korea-regional`(한반도 연안·대양 밴드 1–2 등, 디스크에 여러 .000이 있어도 **시연용 WGS84 박스와 겹치는 셀만 인덱스**해 초기 로딩·메모리를 줄입니다). 폴더 안의 **모든** 셀을 인덱스하려면 환경 변수 `DEFAULT_SAMPLE_INDEX_BOUNDS=all` 을 설정하세요. 사용자 정의 박스는 `DEFAULT_SAMPLE_INDEX_BOUNDS=서경,남위,동경,북위`(쉼표 구분)입니다. 더 넓은 데이터는 UI **업로드**로 넣을 수 있습니다. 캐시는 `/tmp/cache`(재시작 시 초기화)입니다.

**Starter 이상 + 전체 해도 상주**가 필요하면 Blueprint에서 `plan: starter`로 바꾸고 `disk`·`S57_DIR`를 추가합니다:

```yaml
plan: starter
envVars:
  - key: S57_DIR
    value: /data/s57
  - key: CACHE_DIR
    value: /data/cache
disk:
  name: s57-data
  mountPath: /data
  sizeGB: 10
```

배포 후 Render Shell/SFTP로 `/data/s57/`에 `*.000` 파일을 업로드합니다.

### 2. Vercel (프론트)

1. Vercel → **Add New** → **Project** → `s57viewer` 저장소 import
2. `vercel.json`의 Render URL이 실제 서비스 URL과 일치하는지 확인 후 Deploy

### 로컬

```bash
pip install -r requirements.txt
uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

환경 변수: `S57_DIR`, `CACHE_DIR`, `PORT`

## 상세 문서

[DOCUMENTATION.md](DOCUMENTATION.md) 참고.

> 교육·시연 목적이며, 실제 항해용으로 사용할 수 없습니다.
