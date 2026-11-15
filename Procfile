web: gunicorn app:app --bind 0.0.0.0:$PORT --worker-class gthread --workers 1 --threads 16 --timeout 220 --graceful-timeout 30 --keep-alive 5 --access-logfile - --error-logfile -
