const axios = require('axios');
const cheerio = require('cheerio');

// ⚠️ ඔයාගේ Keys මෙතන
const { SCRAPPEY_API_KEY, YOUTUBE_API_KEY, RAPIDAPI_KEY, DOWNLOADER_URL, DOWNLOADER_KEY } = require('../config');

// Cloudflare Bypass Function
async function fetchHtml(url) {
    try {
        const response = await axios.post('https://publisher.scrappey.com/api/v1', {
            key: SCRAPPEY_API_KEY,
            cmd: 'request.get',
            url: url
        });
        return response.data.solution.response; 
    } catch (error) {
        throw new Error("Failed to fetch HTML via Scrappey");
    }
}

module.exports = async (req, res) => {
    // CORS Enable
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET');

    const query = req.query.q;
    const targetUrl = req.query.url;
    const videoId = req.query.id;
    const site = req.query.site || 'fitgirl';

    // 1. YOUTUBE SEARCH
    if (site === 'youtube' && query) {
        try {
            const ytUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=5&q=${encodeURIComponent(query)}&type=video&key=${YOUTUBE_API_KEY}`;
            const response = await axios.get(ytUrl);
            
            if (!response.data.items || response.data.items.length === 0) {
                return res.status(404).json({ status: "error", message: "No results found" });
            }

            const results = response.data.items.map(item => ({
                title: item.snippet.title,
                videoId: item.id.videoId,
                thumbnail: item.snippet.thumbnails.default.url,
                url: `https://www.youtube.com/watch?v=${item.id.videoId}`
            }));

            return res.status(200).json({ status: "success", site, query, results });
        } catch (error) {
            return res.status(500).json({ error: "YouTube Search failed", details: error.message });
        }
    }

    // 2. YOUTUBE DOWNLOAD (MP3)
    if (site === 'youtube' && videoId) {
        // 2a. Own downloader server (hashu-downloader) - preferred
        if (DOWNLOADER_URL && !DOWNLOADER_URL.startsWith('PASTE')) {
            try {
                const r = await axios.get(DOWNLOADER_URL.replace(/\/$/, '') + '/api/mp3', {
                    params: { id: videoId, key: DOWNLOADER_KEY || undefined },
                    timeout: 55000
                });
                if (r.data && r.data.url) {
                    return res.status(200).json({
                        status: "success", site: "youtube", videoId,
                        download_url: r.data.url, title: r.data.title || "YouTube Audio"
                    });
                }
                return res.status(500).json({ error: "Downloader returned no link" });
            } catch (error) {
                const msg = (error.response && error.response.data && error.response.data.error) || error.message;
                return res.status(500).json({ error: "YouTube Download failed", details: msg });
            }
        }

        // 2b. Fallback: RapidAPI youtube-mp36
        if (!RAPIDAPI_KEY || RAPIDAPI_KEY.startsWith('PASTE')) {
            return res.status(500).json({ error: "RAPIDAPI_KEY is not set in config.js" });
        }
        try {
            let data = null;
            for (let i = 0; i < 6; i++) {
                const r = await axios.get('https://youtube-mp36.p.rapidapi.com/dl', {
                    params: { id: videoId },
                    headers: {
                        'x-rapidapi-key': RAPIDAPI_KEY,
                        'x-rapidapi-host': 'youtube-mp36.p.rapidapi.com'
                    },
                    timeout: 20000
                });
                data = r.data;
                if (data && data.status === 'ok' && data.link) break;
                if (data && data.status === 'fail') break;
                await new Promise(r => setTimeout(r, 2000)); // status "processing" -> retry
            }

            if (data && data.status === 'ok' && data.link) {
                return res.status(200).json({
                    status: "success",
                    site: "youtube",
                    videoId,
                    download_url: data.link,
                    title: data.title || "YouTube Audio"
                });
            }
            return res.status(500).json({ error: "Could not generate MP3", details: (data && data.msg) || "Still processing, try again" });
        } catch (error) {
            return res.status(500).json({ error: "YouTube Download failed", details: error.message });
        }
    }

    // 3. FITGIRL & CINESUBZ SEARCH
    if (query) {
        try {
            let url = "";
            if (site === 'fitgirl') url = `https://fitgirl-repacks.site/?s=${encodeURIComponent(query)}`;
            else if (site === 'cinesubz') url = `https://cinesubz.co/?s=${encodeURIComponent(query)}`;
            else return res.status(400).json({ error: "Invalid site." });

            const html = await fetchHtml(url);
            const $ = cheerio.load(html);
            const results = [];
            
            if (site === 'fitgirl') {
                $('article').each((i, el) => {
                    if (i >= 5) return;
                    const title = $(el).find('h1.entry-title a').text().trim();
                    const link = $(el).find('h1.entry-title a').attr('href');
                    if (title && link) results.push({ title, link });
                });
            } else if (site === 'cinesubz') {
                $('.post-item, .movie-item, article').each((i, el) => {
                    if (i >= 5) return;
                    const title = $(el).find('.title, h2, h3').text().trim();
                    const link = $(el).find('a').attr('href');
                    if (title && link) results.push({ title, link });
                });
            }

            return res.status(200).json({ status: "success", site, query, results });
        } catch (error) {
            return res.status(500).json({ error: "Search failed", details: error.message });
        }
    }

    // 4. FITGIRL & CINESUBZ DETAILS & DIRECT LINKS
    if (targetUrl) {
        try {
            const html = await fetchHtml(targetUrl);
            const $ = cheerio.load(html);

            let title = "";
            let description = "";
            const directLinks = [];

            if (site === 'fitgirl') {
                title = $('h1.entry-title').text().trim();
                description = $('.entry-content').text().trim().substring(0, 500);
                $('a').each((i, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().trim();
                    if (href && (href.includes('ddl.to') || href.includes('1fichier') || href.startsWith('magnet:') || href.match(/\.(zip|rar|7z|iso)$/i))) {
                        directLinks.push({ text: text || "Direct Link", url: href });
                    }
                });
            } else if (site === 'cinesubz') {
                title = $('h1.entry-title, .movie-title').text().trim();
                description = $('.entry-content, .movie-desc').text().trim().substring(0, 500);
                $('a').each((i, el) => {
                    const href = $(el).attr('href');
                    const text = $(el).text().trim();
                    if (href && (href.includes('drive.google') || href.includes('mega.nz') || href.includes('pixeldrain') || href.match(/\.(mkv|mp4|srt|zip|rar)$/i))) {
                        directLinks.push({ text: text || "Direct Download", url: href });
                    }
                });
            }

            return res.status(200).json({ status: "success", site, title, url: targetUrl, description, direct_download_links: directLinks });
        } catch (error) {
            return res.status(500).json({ error: "Details failed", details: error.message });
        }
    }

    return res.status(400).json({ error: "Provide q, url, or id parameters" });
};
