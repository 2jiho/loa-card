"""Build local experimental normal/equipped references from verified client sprites.

Outputs stay below work/: this does not update production scanner assets.
Requires Pillow, OpenCV and NumPy. Placement is calibrated, not extracted from
the runtime UI layout. Portrait features exclude names and variable fields.
"""
import argparse, base64, hashlib, json
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

parser=argparse.ArgumentParser()
parser.add_argument('--assets',type=Path,required=True)
root=Path(__file__).resolve().parents[1]
parser.add_argument('--output',type=Path,default=root/'work/composed-card-templates')
args=parser.parse_args()
out=args.output.resolve()
if not out.is_relative_to(root/'work') or out==root/'work':
 parser.error('--output must be a subdirectory of work/')
out.mkdir(parents=True,exist_ok=True)
assets=args.assets
ui=assets/'ui-textures/EFUI_CARDGAMESEASON2/Texture2D'
asset_map=json.loads((root/'scripts/client-card-ui-map.json').read_text('utf8'))
for entry in asset_map['sources']:
 path=assets/entry['file']
 if hashlib.sha256(path.read_bytes()).hexdigest()!=entry['sha256']:
  raise ValueError('Client UI asset hash mismatch: '+entry['file'])
atlas4=Image.open(ui/'cardstorageseason2_i4e.png').convert('RGBA')
atlas2=Image.open(ui/'cardstorageseason2_i2.png').convert('RGBA')
# Atlas rectangles are x/y/width/height. Placement is calibrated against the
# existing screenshot fixture at the scanner's 140x210 crop coordinates.
border_boxes=[(819,261,165,250),(518,553,172,250),(644,3,166,250),(643,261,166,250),(819,3,166,250)]
def crop(im,box):
 x,y,w,h=box
 if x<0 or y<0 or w<=0 or h<=0 or x+w>im.width or y+h>im.height:
  raise ValueError('Invalid atlas rectangle: '+str(box))
 return im.crop((x,y,x+w,y+h))
borders=[crop(atlas4,b).resize((140,210),Image.Resampling.LANCZOS) for b in border_boxes]
equipped=crop(atlas2,(0,749,182,259)).resize((150,218),Image.Resampling.LANCZOS)
name_plate=crop(atlas4,(689,549,164,61)).resize((140,51),Image.Resampling.LANCZOS)
bottom_plate=crop(atlas4,(689,739,164,61)).resize((140,51),Image.Resampling.LANCZOS)
banner=crop(atlas4,(519,858,176,50)).resize((140,40),Image.Resampling.LANCZOS)
font_path=assets/'Binaries/Fonts/HANYoonGothic760.ttf'
font=ImageFont.truetype(str(font_path),19)
name_font=ImageFont.truetype(str(font_path),14)
mapping=json.loads((root/'scripts/client-artwork-map.json').read_text('utf8'))['cards']
cards=json.loads((root/'public/scanner/cards.json').read_text('utf8'))['cards']
by_id={c['id']:c for c in cards}
if len({r['id'] for r in mapping})!=len(mapping):
 raise ValueError('Duplicate artwork mapping IDs')
normal_refs={};equipped_refs={};examples={}
masked_refs={}
# Union of all rarity/overlay alpha: use only artwork pixels visible in every
# state. Exclude text rectangles independently of font rasterization.
ui_alpha=np.zeros((210,140),dtype=np.uint8)
for border in borders:
 ui_alpha=np.maximum(ui_alpha,np.asarray(border)[:,:,3])
overlay=Image.new('RGBA',(140,210))
overlay.alpha_composite(equipped,(-5,-4))
ui_alpha=np.maximum(ui_alpha,np.asarray(overlay)[:,:,3])
safe=(ui_alpha<16).astype(np.uint8)
safe[:54,:]=0;safe[98:,:]=0;safe[:,:10]=0;safe[:,130:]=0
# Keep only bins whose complete footprint is safe, with a one-bin guard for
# translation search. The banner's alpha is not inverted to recover hidden art.
mask=cv2.resize(safe.astype(np.float32),(48,64),interpolation=cv2.INTER_AREA)>.999
mask=cv2.erode(mask.astype(np.uint8),np.ones((3,3),np.uint8))
indices=np.flatnonzero(mask).tolist()
colors=['#efefef','#86c62e','#30b0e1','#ba45d2','#e7a321']
sources={}
def features(image):
 small=cv2.resize(np.asarray(image.convert('RGB')),(24,32),interpolation=cv2.INTER_AREA)
 gray=np.round(small[:,:,0]*.299+small[:,:,1]*.587+small[:,:,2]*.114).astype(np.uint8)
 return base64.b64encode(gray[9:19,2:22].tobytes()).decode()
for ref in mapping:
 card=by_id[ref['id']]
 path=assets/'card-atlases/EFUI_ICONATLAS_C/Texture2D'/ref['sourceAtlas']
 if path.name not in sources:
  if hashlib.sha256(path.read_bytes()).hexdigest()!=ref['sourceSha256']:
   raise ValueError('Card artwork hash mismatch: '+ref['sourceAtlas'])
  sources[path.name]=Image.open(path).convert('RGBA')
 art=crop(sources[path.name],ref['box']).resize((140,210),Image.Resampling.LANCZOS)
 art.alpha_composite(name_plate,(0,0))
 art.alpha_composite(bottom_plate,(0,159))
 normal=Image.alpha_composite(art,borders[card['rarity']])
 small=cv2.resize(np.asarray(normal.convert('RGB')),(48,64),interpolation=cv2.INTER_AREA)
 gray=np.round(small[:,:,0]*.299+small[:,:,1]*.587+small[:,:,2]*.114).astype(np.uint8)
 masked_refs[card['id']]=base64.b64encode(gray.tobytes()).decode()
 equipped_card=normal.copy()
 equipped_card.alpha_composite(equipped,(-5,-4))
 equipped_card.alpha_composite(banner,(0,102))
 draw=ImageDraw.Draw(equipped_card)
 draw.text((70,120),'장착중',font=font,anchor='mm',fill='#fff0cc',stroke_width=0)
 normal_refs[card['id']]=features(normal)
 equipped_refs[card['id']]=features(equipped_card)
 for kind,im in [('normal',normal),('equipped',equipped_card)]:
  # Names are excluded from extracted portrait features; retained in the preview.
  preview=im.copy();d=ImageDraw.Draw(preview)
  name=card['name'];size=14 if name_font.getlength(name)<=132 else 11
  d.text((70,19),name,font=ImageFont.truetype(str(font_path),size),anchor='mm',fill=colors[card['rarity']],stroke_width=0)
  (out/kind).mkdir(exist_ok=True)
  preview.convert('RGB').save(out/kind/(card['artwork'].replace('.webp','.png')))
 if card['name'] in ['프랭크','헨리','제레온','샨디']:
  examples[card['name']]=card['id']
(out/'normal-details.json').write_text(json.dumps(normal_refs,separators=(',',':'))+'\n')
(out/'equipped-details.json').write_text(json.dumps(equipped_refs,separators=(',',':'))+'\n')
(out/'masked-details.json').write_text(json.dumps({'width':48,'height':64,'indices':indices,'cards':masked_refs},separators=(',',':'))+'\n')
provenance={'canvas':[140,210],'borderBoxes':border_boxes,'plates':{'name':[689,549,164,61,0,0,140,51],'bottom':[689,739,164,61,0,159,140,51]},'equipped':{'atlas':'cardstorageseason2_i2.png','box':[0,749,182,259],'size':[150,218],'position':[-5,-4]},'banner':{'atlas':'cardstorageseason2_i4e.png','box':[519,858,176,50],'size':[140,40],'position':[0,102]},'font':{'file':font_path.name,'size':19,'center':[70,120]},'hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [ui/'cardstorageseason2_i2.png',ui/'cardstorageseason2_i4e.png',font_path]},'cards':len(normal_refs),'placementSource':'calibrated against existing screenshots; not verified runtime UI transforms','excludedFromPortraitFeatures':['name','awakening','extraCopies']}
provenance['maskedPortrait']={'resolution':[48,64],'pixels':len(indices),'source':'normal image before label rendering','mask':'union of rarity/equipped frame alpha < 16; x 10..129, y 54..97; full-area safe bins eroded by one bin','fontIndependent':True}
(out/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
print(json.dumps({'cards':len(normal_refs),'variants':len(normal_refs)*2,'examples':examples},ensure_ascii=False))
