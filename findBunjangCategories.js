// findBunjangCategories.js
require('dotenv').config(); // .env 파일 로드 (config/index.js 와 유사하게)
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

// --- 설정 값 (실제 프로젝트의 config 모듈을 가져오거나 직접 입력) ---
// 실제 프로젝트에서는 require('./src/config') 와 같이 가져올 수 있습니다.
// 이 스크립트를 프로젝트 루트에 만들었다면 경로 조정이 필요합니다.
// 여기서는 직접 .env 값을 사용하도록 간단히 구성합니다.
const BUNJANG_API_BASE_URL = process.env.BUNJANG_API_GENERAL_URL || "https://openapi.bunjang.co.kr"; // [cite: 1]
const BUNJANG_ACCESS_KEY = process.env.BUNJANG_API_ACCESS_KEY;
const BUNJANG_SECRET_KEY_BASE64 = process.env.BUNJANG_API_SECRET_KEY;

/**
 * 번개장터 API 요청을 위한 JWT 인증 헤더를 생성합니다.
 * (catalogService.js의 함수와 동일한 로직)
 */
async function generateBunjangAuthHeader() {
  if (!BUNJANG_ACCESS_KEY || !BUNJANG_SECRET_KEY_BASE64) {
    console.error('[AuthUtil] Bunjang API Access Key or Secret Key is missing in environment variables.');
    throw new Error('Bunjang API credentials missing.');
  }
  try {
    const secretKeyDecoded = Buffer.from(BUNJANG_SECRET_KEY_BASE64, 'base64');
    const payload = {
      accessKey: BUNJANG_ACCESS_KEY, // [cite: 6]
      // nonce: uuidv4(), // GET 요청에는 nonce가 필수는 아니라고 문서에 명시 (POST, PUT, DELETE에 필요) [cite: 7]
      iat: Math.floor(Date.now() / 1000), // [cite: 7, 17]
    };
    const jwtToken = jwt.sign(payload, secretKeyDecoded, { algorithm: 'HS256' });
    return { 'Authorization': `Bearer ${jwtToken}` }; // [cite: 5]
  } catch (error) {
    console.error('[AuthUtil] Failed to generate Bunjang JWT:', error);
    throw new Error('Failed to generate Bunjang JWT.');
  }
}

/**
 * 번개장터 카테고리 API를 호출하여 전체 카테고리 목록을 가져옵니다.
 */
async function fetchAllBunjangCategories() {
  try {
    const authHeader = await generateBunjangAuthHeader();
    const apiUrl = `${BUNJANG_API_BASE_URL}/api/v1/categories`; // [cite: 77]
    
    console.log(`Workspaceing categories from: ${apiUrl}`);
    
    const response = await axios.get(apiUrl, {
      headers: { ...authHeader },
      timeout: 10000, // 10초 타임아웃
    });

    if (response.data && response.data.data) { // [cite: 77]
      console.log(`Successfully fetched ${response.data.data.length} categories.`);
      return response.data.data; // 카테고리 객체 배열 반환
    } else {
      console.error('No category data found in Bunjang API response:', response.data);
      return [];
    }
  } catch (error) {
    const errorMsg = error.response ? `Status: ${error.response.status}, Data: ${JSON.stringify(error.response.data)}` : error.message;
    console.error('Error fetching Bunjang categories:', errorMsg);
    if (error.response?.status === 401) { // [cite: 71, 72, 73]
        console.error('Authentication error. Check your Bunjang API keys and JWT generation.');
    }
    return [];
  }
}

/**
 * 주어진 키워드 목록과 일치하는 카테고리를 찾습니다.
 * @param {Array<Object>} categories - 전체 카테고리 목록 (각 객체는 id, nameKor, nameEng 포함)
 * @param {Array<string>} keywords - 검색할 키워드 배열 (소문자로)
 * @returns {Array<Object>} 키워드와 일치하는 카테고리 객체 배열
 */
function findMatchingCategories(categories, keywords) {
  const matchedCategories = [];
  const lowerKeywords = keywords.map(kw => kw.toLowerCase());

  categories.forEach(category => {
    const nameKorLower = (category.nameKor || '').toLowerCase(); // [cite: 77]
    const nameEngLower = (category.nameEng || '').toLowerCase(); // [cite: 77]

    if (lowerKeywords.some(kw => nameKorLower.includes(kw) || nameEngLower.includes(kw))) {
      matchedCategories.push({
        id: category.id, // [cite: 77]
        nameKor: category.nameKor,
        nameEng: category.nameEng
      });
    }
  });
  return matchedCategories;
}

// 메인 실행 함수
async function main() {
  if (!BUNJANG_ACCESS_KEY || !BUNJANG_SECRET_KEY_BASE64) {
    console.log("Please set BUNJANG_API_ACCESS_KEY and BUNJANG_API_SECRET_KEY in your .env file.");
    return;
  }

  const allCategories = await fetchAllBunjangCategories();

  if (allCategories.length > 0) {
    const targetKeywords = [
      // K-Pop 관련 키워드
      "k-pop", "케이팝", "아이돌", "idol", "앨범", "album", "포토카드", "photocard", "굿즈", "goods", "음반",
      // 키덜트 관련 키워드
      "키덜트", "kidult", "피규어", "figure", "프라모델", "plamodel", "건담", "gundam", "레고", "lego", "장난감", "toy", "인형", "doll"
      // 필요에 따라 더 많은 키워드 추가
    ];

    const relevantCategories = findMatchingCategories(allCategories, targetKeywords);

    if (relevantCategories.length > 0) {
      console.log("\n--- K-Pop 또는 키덜트 관련 카테고리 ---");
      relevantCategories.forEach(cat => {
        console.log(`ID: ${cat.id}, 한글명: ${cat.nameKor}, 영문명: ${cat.nameEng}`);
      });
      console.log("\n위 ID들을 복사하여 .env 파일의 BUNJANG_FILTER_CATEGORY_IDS 값으로 사용하세요 (쉼표로 구분).");
      console.log("예: BUNJANG_FILTER_CATEGORY_IDS=12345,67890,11223");
    } else {
      console.log("주어진 키워드와 일치하는 카테고리를 찾지 못했습니다. 키워드를 확인하거나 전체 카테고리 목록을 직접 살펴보세요.");
      // 모든 카테고리 목록을 보고 싶다면 아래 주석 해제 (목록이 매우 길 수 있음)
      // console.log("\n--- 전체 카테고리 목록 ---");
      // allCategories.forEach(cat => {
      //   console.log(`ID: ${cat.id}, 한글명: ${cat.nameKor}, 영문명: ${cat.nameEng}`);
      // });
    }
  }
}

main();