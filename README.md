# TRACE Host Trial API

별별모임터 호스트 체험 신청을 저장하는 전용 API입니다.

- `POST /api/applications`: 신청 접수
- `GET /health`: 상태 확인
- `GET /api/admin/applications`: Bearer 토큰이 필요한 관리자 조회

개인정보는 Render PostgreSQL에 저장되며 공개 저장소에는 비밀값을 넣지 않습니다.
