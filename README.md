# S-57 Web Chart Viewer

대한민국 S-57 전자해도(ENC) 데이터를 웹 브라우저에서 조회하는 뷰어입니다.

## 요구 사항

- Python 3.10+
- GDAL (pyogrio 의존)
- 로컬 S-57 해도 데이터 경로 (`server.py`의 `S57_DIR`)

## 실행

```bash
pip install -r requirements.txt
uvicorn server:app --reload --host 0.0.0.0 --port 8000
```

브라우저에서 `http://localhost:8000` 을 엽니다.

## 배포

이 앱은 **GDAL/pyogrio**와 **로컬 S-57 해도 파일**이 필요합니다. Vercel 단독 배포는 불가하며, 아래 조합을 권장합니다.

| 구성 | 역할 |
|------|------|
| [Render](https://render.com) (Docker) | FastAPI + S-57 데이터 처리 |
| [Vercel](https://vercel.com) | 정적 UI (`static/`), `/api`는 Render로 프록시 |

### 1. Render (백엔드)

1. [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint** → GitHub `ejavm83/s57viewer` 연결
2. Persistent Disk(`/data`)에 S-57 `*.000` 파일 업로드 (SFTP/Shell)
3. 환경 변수: `S57_DIR=/data/s57` (해도가 `s57` 하위 폴더에 있을 때)
4. 배포 URL 예: `https://s57viewer.onrender.com`

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
