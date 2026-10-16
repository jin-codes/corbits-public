# 서버에 올리기: Oracle Cloud Always Free (ARM)

맥을 꺼도 Corbits가 돌아가도록 한 대의 무료 서버에 전체를 올리는 절차입니다.
구성: 서버 1대 안에서 Docker Compose로 postgres + app + browser(샌드박스) + gateway를 실행하고,
접속은 공개 인터넷이 아니라 **Tailscale**(내 기기에서만)로 합니다.

> 가격, 무료 한도, 정책은 바뀝니다. 가입 전에 Oracle 공식 "Always Free" 문서를 다시 확인하세요.

## 0. 이 구성이 검증된 범위
이 저장소의 운영용 구성(`Dockerfile`, `docker-compose.prod.yml`)은 arm64 머신에서 직접 빌드해
다음을 확인했습니다: app 기동, 앱 컨테이너 → gateway → 샌드박스 브라우저 연결, Postgres 백업,
읽기 전용 루트 파일시스템과 비루트 실행. **확인하지 못한 것**: 실제 Claude 로그인 토큰으로 모델을 호출하는 부분
(토큰이 있어야 해서), Oracle 서버 자체에서의 동작.

## 1. 서버 만들기 (Oracle Cloud 콘솔)
1. 계정을 만들고(카드 인증 필요) 홈 리전을 고릅니다. 홈 리전은 나중에 못 바꿉니다. 가입 화면에 한국(서울, 춘천)이 없으면 **Japan Central (Osaka)**(도쿄보다 덜 붐빈다고 알려져 있음)를 고르세요.
2. Compute → Instances → Create instance
   - Image: **Ubuntu 24.04 (aarch64)**
   - Shape: **VM.Standard.A1.Flex**, 2 OCPU / 12 GB 정도부터 (무료 한도는 합계 4 OCPU / 24 GB)
   - Boot volume: 50 GB 이상
   - SSH 키: 내 공개키 등록
   - "Out of capacity" 오류가 나면 시간대를 바꿔 재시도하거나 다른 가용 도메인을 고릅니다.
3. 유휴 서버 회수 정책이 있습니다(CPU 사용률이 오랫동안 매우 낮으면 회수될 수 있음). 정책 문구를 확인하고,
   걱정되면 계정을 Pay As You Go로 전환하면 무료 한도 안에서는 과금되지 않는다는 안내가 흔합니다(공식 문서로 확인).

## 2. 서버 준비 (SSH로 접속해서)
```bash
sudo apt-get update && sudo apt-get -y upgrade
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER   # 다시 로그인해야 적용됩니다
sudo apt-get -y install git
```

## 3. Tailscale (공개 노출 없이 접속)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --ssh
```
- 내 맥과 폰에도 Tailscale을 설치하고 같은 계정으로 로그인합니다.
- Tailscale 관리 콘솔에서 **HTTPS Certificates**를 켭니다.
- 확인이 끝나면 Oracle 콘솔의 보안 목록(Security List)에서 **인바운드 SSH(22)를 닫아도** 됩니다. 이후엔 `tailscale ssh`로 접속합니다.
- Corbits 포트(8787)는 서버 밖으로 열지 않습니다.

## 4. 코드와 설정
```bash
git clone https://github.com/jin-codes/corbits-public.git && cd corbits-public
cp .env.example .env
```
`.env`에 채울 것 (값은 채팅에 붙여넣지 말고 서버에서 직접 편집):

| 항목 | 만드는 방법 |
|---|---|
| `CORBITS_API_TOKENS` | `node -e "console.log('jin:'+require('crypto').randomBytes(32).toString('hex'))"` (서버에 node가 없으면 `openssl rand -hex 32`로 만들고 앞에 `jin:` 붙이기) |
| `CORBITS_SECRETS_KEY` | `openssl rand -hex 32` — **서버 밖에 따로 백업** (잃으면 저장된 로그인 정보를 복구 못 합니다) |
| `CORBITS_BROWSER_WS_SECRET` | `openssl rand -hex 24` |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` |
| `CORBITS_CLAUDE_MODEL` | `.env.example` 값 그대로 |
| `CLAUDE_CODE_OAUTH_TOKEN` | **내 맥에서** `claude setup-token` 실행 후 나온 토큰 (구독 계정, 1년 유효, 모델 호출만 가능, 개인용) |
| SMTP / 메일 | 지금 맥의 `.env` 값 그대로 (Gmail 앱 비밀번호) |
| `CORBITS_PUBLIC_URL` | 5단계에서 나오는 `https://<서버이름>.<tailnet>.ts.net` |

`CLAUDE_CODE_OAUTH_TOKEN`은 만료되면(1년) 모델 호출이 실패합니다. 갱신하면 `.env`만 바꾸고 `docker compose ... up -d app`.

## 5. 실행
```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml logs -f app   # [model] ... 줄이 보이면 정상
sudo tailscale serve --bg 8787       # https://<서버이름>.<tailnet>.ts.net 로 접속
```
모든 컨테이너가 `restart: unless-stopped`이고 Docker가 부팅 시 자동 시작되므로 서버를 재부팅해도 다시 올라옵니다.

## 6. 백업
```bash
crontab -e
# 매일 새벽 4시 (UTC) 백업, 최신 14개 유지
0 4 * * * cd /home/ubuntu/corbits && ./scripts/backup.sh >> backups/backup.log 2>&1
```
같은 디스크의 백업만으로는 부족합니다. 가끔 `scp`로 맥에 내려받거나, Oracle Object Storage(무료 한도 있음)에 올리세요.
복구(현재 DB를 덮어씁니다): `docker compose -f docker-compose.yml -f docker-compose.prod.yml stop app && ./scripts/restore.sh backups/<파일>.sql.gz`

## 7. 업데이트
```bash
git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

## 알아둘 점
- 메일은 587/465 포트를 쓰세요. 많은 클라우드가 25번 포트는 막습니다.
- 이 서버에는 브라우저 컨테이너가 쓰는 메모리(최대 3GB)가 포함되어야 하므로 RAM은 8GB 이상을 권장합니다.
- 여러 사용자에게 공개하려면 먼저 HTTPS 계정 체계, 요청 제한 등이 필요합니다(README의 Roadmap).
