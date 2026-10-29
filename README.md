# Hashu Hub (all-in-one)

Website + API + MP3 downloader in ONE server.

## Deploy on Google Cloud Run (run in this folder)
    gcloud run deploy hashu-hub --source . --region asia-southeast1 \
      --allow-unauthenticated --max-instances 1 --memory 1Gi --timeout 300

Open the URL it prints. Done. (max-instances 1 is needed: MP3 files live on the instance.)

## Railway / Render
Push to GitHub -> Deploy from repo (Dockerfile is detected).

## Keys
All keys are in config.js (SCRAPPEY_API_KEY, YOUTUBE_API_KEY).
If YouTube says "confirm you're not a bot", set env YT_COOKIES_B64 (base64 of a cookies.txt).

## Heroku (paid, 30s request limit)
    heroku login
    heroku create your-app-name
    heroku stack:set container
    git push heroku main
(heroku.yml is included. Open the app: heroku open)
