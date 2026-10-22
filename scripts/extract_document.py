import sys, json, zipfile, pathlib, xml.etree.ElementTree as ET
p=pathlib.Path(sys.argv[1])
if p.stat().st_size > 20*1024*1024: raise ValueError('Choose a file smaller than 20 MB.')
if p.suffix.lower()=='.pdf':
    from pypdf import PdfReader
    text='\n\n'.join(page.extract_text() or '' for page in PdfReader(p).pages)
elif p.suffix.lower()=='.docx':
    with zipfile.ZipFile(p) as z:
        if z.getinfo('word/document.xml').file_size>20*1024*1024: raise ValueError('Document is too large.')
        root=ET.fromstring(z.read('word/document.xml'))
        ns={'w':'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        text='\n'.join(''.join(t.text or '' for t in para.findall('.//w:t',ns)) for para in root.findall('.//w:p',ns))
else:
    text=p.read_text(encoding='utf-8-sig')
if not text.strip(): raise ValueError('No readable text found. Scanned PDFs need OCR before import.')
if len(text)>100000: raise ValueError('Document exceeds 100,000 characters. Import a focused excerpt.')
print(json.dumps({'name':p.name,'text':text.strip()}))
