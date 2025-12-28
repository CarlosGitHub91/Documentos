import axios from 'axios';
import CloudConvert from 'cloudconvert';
import dotenv from 'dotenv';
import express from 'express';
import FormData from 'form-data';
import multer from 'multer';

dotenv.config();

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;
const ALLOWED_TARGETS = ['pdf', 'docx', 'xlsx'];

if (!process.env.CLOUDCONVERT_API_KEY) {
  console.warn('Falta CLOUDCONVERT_API_KEY en las variables de entorno');
}

const cloudConvert = new CloudConvert(process.env.CLOUDCONVERT_API_KEY);

app.get('/health', (_req, res) => res.json({ ok: true }));

// POST /convert  (multipart: file, target)
app.post('/convert', upload.single('file'), async (req, res) => {
  try {
    const target = (req.body.target || '').toLowerCase();
    if (!ALLOWED_TARGETS.includes(target)) {
      return res.status(400).json({ error: 'target debe ser pdf|docx|xlsx' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Falta file' });
    }

    // 1) Crear job
    const job = await cloudConvert.jobs.create({
      tasks: {
        import: { operation: 'import/upload' },
        convert: { operation: 'convert', input: 'import', output_format: target },
        export: { operation: 'export/url', input: 'convert' }
      }
    });

    const importTask = job.tasks.find(t => t.name === 'import');
    if (!importTask?.result?.form?.url) throw new Error('No se obtuvo URL de import');

    // 2) Subir el archivo a la URL de import
    const form = new FormData();
    for (const [key, value] of Object.entries(importTask.result.form.parameters)) {
      form.append(key, value);
    }
    form.append('file', req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype
    });

    await axios.post(importTask.result.form.url, form, {
      headers: form.getHeaders()
    });

    // 3) Esperar a que termine el job
    const waitJob = await cloudConvert.jobs.wait(job.id); // bloquea hasta finished
    const exportTask = waitJob.tasks.find(
      t => t.operation === 'export/url' && t.status === 'finished'
    );
    if (!exportTask?.result?.files?.length) throw new Error('No se obtuvo archivo exportado');

    const fileUrl = exportTask.result.files[0].url;

    // 4) Descargar y enviar al cliente
    const fileResp = await axios.get(fileUrl, { responseType: 'stream' });
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${req.file.originalname}.${target}"`
    );
    fileResp.data.pipe(res);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Error en conversión' });
  }
});

app.listen(PORT, () => {
  console.log(`Converter backend running on port ${PORT}`);
});