const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');
const axios = require('axios');
const { join } = require('path');
const { Low } = require('lowdb');
const { JSONFile } = require('lowdb/node');

const app = express();
const PORT = process.env.PORT || 3001;

// --- Configuração da Base de Dados Persistente (lowdb) ---
const file = join(__dirname, 'db.json');
const adapter = new JSONFile(file);
const db = new Low(adapter, { sources: [], images: [], favorites: [] });

// --- CORS de Produção ---
// CORREÇÃO DEFINITIVA: Usa a variável de ambiente que configurou no Render
const corsOptions = {
  origin: process.env.FRONTEND_URL || 'http://localhost:3000'
};
app.use(cors(corsOptions));
app.use(express.json());

// --- Cache em Memória ---
const cache = new Map();
const CACHE_DURATION_MS = 15 * 60 * 1000;

// --- Endpoints da API ---
app.get('/api/sources', async (req, res) => {
    await db.read();
    res.json(db.data.sources);
});
app.delete('/api/sources/:id', async (req, res) => {
    const { id } = req.params;
    await db.read();
    const sourceToRemove = db.data.sources.find(s => s.id === id);
    if (!sourceToRemove) {
        return res.status(404).json({ message: 'Fonte não encontrada.' });
    }
    db.data.sources = db.data.sources.filter(source => source.id !== id);
    const imagesToRemoveIds = new Set(db.data.images.filter(img => img.sourceId === id).map(img => img.id));
    db.data.images = db.data.images.filter(image => image.sourceId !== id);
    db.data.favorites = db.data.favorites.filter(favId => !imagesToRemoveIds.has(favId));
    await db.write();
    if (sourceToRemove.url) cache.delete(sourceToRemove.url);
    res.status(200).json({ success: true, message: 'Fonte e imagens removidas com sucesso.' });
});
app.get('/api/images', async (req, res) => {
    await db.read();
    const { images, favorites } = db.data;
    const favoriteSet = new Set(favorites);
    const imagesWithFavorites = images.map(img => ({ ...img, isFavorited: favoriteSet.has(img.id) }));
    res.json(imagesWithFavorites);
});
app.post('/api/favorites', async (req, res) => {
    const { imageId, favorite } = req.body;
    if (typeof imageId === 'undefined' || typeof favorite === 'undefined') {
        return res.status(400).json({ message: 'imageId e favorite são obrigatórios.' });
    }
    await db.read();
    const favoriteSet = new Set(db.data.favorites);
    if (favorite) {
        favoriteSet.add(imageId);
    } else {
        favoriteSet.delete(imageId);
    }
    db.data.favorites = Array.from(favoriteSet);
    await db.write();
    res.status(200).json({ success: true, favorites: db.data.favorites });
});
app.get('/api/download', async (req, res) => {
    const { url } = req.query;
    if (!url) {
        return res.status(400).json({ message: 'URL da imagem é obrigatória.' });
    }
    try {
        const response = await axios({ method: 'GET', url: url, responseType: 'stream' });
        res.setHeader('Content-Disposition', 'attachment; filename="image.jpg"');
        response.data.pipe(res);
    } catch (error) {
        console.error('Erro ao fazer proxy do download:', error.message);
        res.status(500).json({ message: 'Não foi possível baixar a imagem.' });
    }
});


app.post('/api/images/scrape', async (req, res) => {
    const { url } = req.body;
    if (!url) {
        return res.status(400).json({ message: 'URL é obrigatória.' });
    }

    if (cache.has(url) && (Date.now() - cache.get(url).timestamp < CACHE_DURATION_MS)) {
        console.log(`A devolver resultados do cache para a URL: ${url}`);
        return res.status(200).json(cache.get(url).data);
    }

    console.log(`POST /api/images/scrape -> Cache inválido. A iniciar busca real na URL: ${url}`);

    let browser = null;
    try {
        browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
            ignoreHTTPSErrors: true,
        });

        const page = await browser.newPage();
        
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            if (['stylesheet', 'font', 'script', 'other'].includes(req.resourceType())) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });

        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;
                    if (totalHeight >= scrollHeight - window.innerHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });

        const imageUrls = await page.evaluate(() => {
            const images = Array.from(document.querySelectorAll('img'));
            const uniqueUrls = new Set();
            for (const img of images) {
                if (img.naturalWidth > 150 && img.naturalHeight > 150) {
                    uniqueUrls.add(img.src);
                }
            }
            return Array.from(uniqueUrls);
        });

        if (imageUrls.length === 0) {
           return res.status(404).json({ message: 'Nenhuma imagem de alta qualidade encontrada nesta URL.' });
        }

        await db.read();
        const newSource = { id: crypto.randomUUID(), url: url, name: new URL(url).hostname };
        db.data.sources.push(newSource);

        const newImages = imageUrls.map((imageUrl, i) => ({
            id: `scrape_${Date.now()}_${i}`,
            src: imageUrl,
            alt: `Imagem de ${newSource.name}`,
            source: newSource.name,
            author: 'WebScraper',
            sourceId: newSource.id
        }));

        db.data.images.unshift(...newImages);
        await db.write();

        const responseData = { newSource, newImages };
        cache.set(url, { data: responseData, timestamp: Date.now() });

        res.status(201).json(responseData);

    } catch (error) {
        console.error("Erro durante o web scraping:", error);
        res.status(500).json({ message: 'Ocorreu um erro ao tentar buscar imagens da URL. O site pode estar protegido ou demorou demasiado tempo a responder.' });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

// Inicia o servidor
app.listen(PORT, async () => {
    await db.read();
    console.log(`Servidor backend a correr em http://localhost:${PORT}`);
    console.log(`Base de dados carregada a partir de: ${file}`);
});
