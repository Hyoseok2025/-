<script>
    // ==========================================
    // ⚠️ 중요: 여기에 발급받은 OpenAI API 키를 넣으세요!
    // ==========================================
    // IMPORTANT: Replace with your real API key via environment variable in production.
    // Do NOT commit real keys. Use `process.env.OPENAI_API_KEY` or similar.
    const API_KEY = 'AIzaSyAPiIhzHr1mb-jOZW91C9jYDYY7Q6N-M30'
    
    // --- 0. 캐릭터 페르소나 데이터 (Prompt Engineering) ---
    const characters = {
        horn: {
            name: "백발의 노장군 호른",
            greeting: "하하하! 왔는가, 나의 책사여! 오늘은 어떤 지략을 들려주려나?",
            systemPrompt: `
                당신은 '백발의 노장군 호른'입니다. 
                사용자(User)는 당신의 오랜 전우이자 신뢰하는 '책사'입니다.
                
                [성격] 호탕함, 강직함, 인정 많음, 충성심 강함.
                [외모] 70세 노인, 거대한 근육질, 왼쪽 눈 실명, 오른팔 없음(외팔이), 대검 사용.
                [말투] 굵고 낮은 목소리, "하하하!"하고 자주 웃음. 반말을 사용하되 위엄이 있음.
                [관계] 사용자를 "책사"라고 부르며 깊이 신뢰함.
                
                대화 가이드라인:
                1. 언제나 호탕한 전장의 장군처럼 행동하십시오.
                2. 사용자의 조언을 귀담아듣거나, 전장의 무용담을 이야기해 주십시오.
                3. 팔 하나 없는 것은 훈장으로 여깁니다.
            `
        },
        hwarin: {
            name: "여검사 모용화린",
            greeting: "왔느냐. 검을 잡는 자세가 흐트러졌구나, 제자야.",
            systemPrompt: `
                당신은 '여검사 모용화린'입니다. 별호는 검제(劍帝).
                사용자(User)는 당신의 하나뿐인 '직전제자'입니다.
                
                [성격] 냉정함, 침착함, 이성적, 겉으론 차갑지만 속으론 제자를 아낌.
                [외모] 검은 머리를 질끈 묶은 젊은 여성, 차가운 눈빛, 무협풍 복장.
                [말투] 감정이 드러나지 않는 단호하고 낮은 어조. 하오체나 하게체를 사용.
                [관계] 사용자를 "제자" 또는 "너"라고 부름. 
                
                대화 가이드라인:
                1. 감정을 절제하며 검의 도(道)에 대해 이야기하십시오.
                2. 겉으로는 엄격하게 꾸짖지만, 제자의 안위를 걱정하는 뉘앙스를 풍기십시오.
                3. 농담을 거의 하지 않습니다.
            `
        },
        kai: {
            name: "불법 시술사 카이",
            greeting: "어이 챔피언! 또 어디 부서져서 왔어? 싸게 해줄게~",
            systemPrompt: `
                당신은 네오서울 뒷골목의 '불법 로봇 개조 시술사 카이'입니다.
                사용자(User)는 투기장의 '챔피언'이자 당신의 단골 고객입니다.
                
                [성격] 장난기 많음, 능글맞음, 천재적이지만 게으른 척함, 속정 깊음.
                [외모] 은발, 붉은 눈, 기계 의수, 의사 가운, 사이버펑크 스타일.
                [말투] 빠르고 유쾌함. 비속어나 은어를 가볍게 섞어 씀. 반말 사용.
                [관계] 사용자를 "챔피언"이라고 부르며 친구처럼 대함.
                
                대화 가이드라인:
                1. 시술 비용이나 부품 이야기를 하며 농담을 던지십시오.
                2. 사용자의 몸 상태(기계 팔/다리 등)를 걱정하되 장난스럽게 표현하십시오.
                3. 진지한 상황에서도 유머를 잃지 마십시오.
            `
        }
    };

    let currentCharacter = null;
    let chatHistory = []; // 사용자: { role: 'user', content: '...' }, 모델: { role: 'assistant', content: '...' }

    // --- 1. GSAP & ScrollTrigger ---
    gsap.registerPlugin(ScrollTrigger);

    gsap.to(".hero .animate-text", {
        y: 0, opacity: 1, duration: 1.5, stagger: 0.3, ease: "power4.out"
    });

    const scrollElements = document.querySelectorAll(".animate-scroll");
    scrollElements.forEach(el => {
        gsap.fromTo(el, 
            { y: 50, opacity: 0 },
            {
                y: 0, opacity: 1, duration: 1.0, ease: "power3.out",
                scrollTrigger: { trigger: el, start: "top 85%" }
            }
        );
    });

    // --- 2. 커서 로직 ---
    if (window.matchMedia("(pointer: fine)").matches) {
        const cursor = document.querySelector('.cursor');
        const hoverTargets = document.querySelectorAll('.hover-target, a, iframe, .card'); // .card 추가

        document.addEventListener('mousemove', (e) => {
            gsap.to(cursor, { x: e.clientX, y: e.clientY, duration: 0.1, ease: "power2.out" });
        });

        // 동적으로 요소가 생겨도 대응하기 위해 body에 이벤트 위임 권장하나 간단히 처리
        document.body.addEventListener('mouseover', (e) => {
            if(e.target.closest('.hover-target') || e.target.closest('a') || e.target.closest('button')) {
                cursor.classList.add('hovered');
            } else {
                cursor.classList.remove('hovered');
            }
        });
    }

    // --- 3. 배경 파티클 (변경 없음) ---
    const canvas = document.getElementById('bg-canvas');
    const ctx = canvas.getContext('2d');
    let width, height, particles = [];

    function resize() { width = canvas.width = window.innerWidth; height = canvas.height = window.innerHeight; }
    window.addEventListener('resize', () => { resize(); initParticles(); });
    resize();

    class Particle {
        constructor() {
            this.x = Math.random() * width; this.y = Math.random() * height;
            this.vx = (Math.random() - 0.5) * 0.5; this.vy = (Math.random() - 0.5) * 0.5;
            this.size = Math.random() * 2;
            this.color = Math.random() > 0.5 ? 'rgba(0, 242, 255, ' : 'rgba(112, 0, 255, ';
        }
        update() {
            this.x += this.vx; this.y += this.vy;
            if (this.x < 0) this.x = width; if (this.x > width) this.x = 0;
            if (this.y < 0) this.y = height; if (this.y > height) this.y = 0;
        }
        draw() {
            ctx.beginPath(); ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fillStyle = this.color + Math.random() * 0.5 + ')'; ctx.fill();
        }
    }

    function initParticles() {
        particles = [];
        const count = window.innerWidth < 768 ? 25 : 50; 
        for (let i = 0; i < count; i++) particles.push(new Particle());
    }
    function animateParticles() {
        ctx.clearRect(0, 0, width, height);
        particles.forEach(p => { p.update(); p.draw(); });
        requestAnimationFrame(animateParticles);
    }
    initParticles(); animateParticles();

    // --- 4. 채팅 시스템 로직 (OpenAI API로 변경) ---
    const modal = document.getElementById('chatModal');
    const chatTitle = document.getElementById('chatTitle');
    const chatMessages = document.getElementById('chatMessages');
    const chatInput = document.getElementById('chatInput');
    const sendBtn = document.getElementById('sendBtn');
    const closeBtn = document.getElementById('closeChat');
    const typingIndicator = document.getElementById('typingIndicator');

    // 카드 클릭 이벤트
    document.querySelectorAll('.card').forEach(card => {
        card.addEventListener('click', () => {
            const charKey = card.getAttribute('data-character');
            if (characters[charKey]) {
                openChat(charKey);
            }
        });
    });

    function openChat(charKey) {
        currentCharacter = characters[charKey];
        chatTitle.innerText = currentCharacter.name;
        chatMessages.innerHTML = ''; // 이전 대화 초기화
        chatHistory = []; // 기록 초기화
        
        // 모달 열기
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden'; // 배경 스크롤 방지
        
        // 첫 인사말 출력
        addMessage(currentCharacter.greeting, 'ai');
        // 첫 인사말은 history에 넣지 않습니다. (API 호출 때 시스템 프롬프트만으로 시작)
        // 입력창에 포커스하여 사용자가 바로 입력할 수 있게 함
        setTimeout(() => {
            try { chatInput.focus(); } catch (e) { /* ignore */ }
        }, 60);
    }

    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
        document.body.style.overflow = 'auto';
    });

    // ESC 키로 모달 닫기
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') {
            modal.style.display = 'none';
            document.body.style.overflow = 'auto';
        }
    });

    function addMessage(text, sender) {
        const div = document.createElement('div');
        div.classList.add('message', sender);
        
        // AI 메시지는 마크다운 파싱 
        if (sender === 'ai') {
            // marked.js 사용 (HTML head에 스크립트가 로드되어 있음)
            div.innerHTML = marked.parse(text); 
        } else {
            div.textContent = text;
        }
        
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    async function sendMessage() {
        const text = chatInput.value.trim();
        if (!text) return;
        
        // 유저 메시지 표시 및 히스토리에 추가
        addMessage(text, 'user');
        chatHistory.push({ role: "user", content: text });
        chatInput.value = '';
        
        // 로딩 표시
        typingIndicator.style.display = 'block';
        // OpenAI 호출은 서버사이드 프록시로 전달합니다.
        try {
            // 시스템 프롬프트와 대화 히스토리 결합
            const messagesForApi = [
                {
                    role: "system",
                    content: currentCharacter.systemPrompt // 시스템 프롬프트 주입
                },
                ...chatHistory,
            ];

            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'gpt-3.5-turbo', messages: messagesForApi })
            });

            // 안전하게 응답 처리: 빈 바디나 비-JSON에 대비
            const text = await response.text();
            let data = null;
            try {
                data = text ? JSON.parse(text) : null;
            } catch (err) {
                throw new Error('서버가 JSON을 반환하지 않았습니다: ' + text);
            }

            if (!data) throw new Error('서버 응답이 비어 있습니다.');
            if (data.error) {
                throw new Error(data.error.message || JSON.stringify(data.error));
            }

            // AI 응답 텍스트 추출 (OpenAI 포맷)
            const aiResponse = data.choices?.[0]?.message?.content || data.choices?.[0]?.text || (data.choices ? JSON.stringify(data.choices) : JSON.stringify(data));

            // AI 응답을 히스토리에 추가
            chatHistory.push({ role: "assistant", content: aiResponse });

            typingIndicator.style.display = 'none';
            addMessage(aiResponse, 'ai');

        } catch (error) {
            console.error(error);
            typingIndicator.style.display = 'none';
            addMessage("오류가 발생했습니다: " + error.message, 'ai');
        }
    }

    // 전송 이벤트
    sendBtn.addEventListener('click', sendMessage);
    chatInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendMessage();
    });

</script>