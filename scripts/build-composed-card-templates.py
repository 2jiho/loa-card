"""Build local experimental normal/equipped references from verified client sprites.

Outputs stay below work/: this does not update production scanner assets.
Requires Pillow, OpenCV and NumPy. Placement is calibrated, not extracted from
the runtime UI layout. Portrait features exclude names and variable fields.
"""
import argparse, base64, hashlib, json, sys
from pathlib import Path
import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

parser=argparse.ArgumentParser()
parser.add_argument('--assets',type=Path,required=True)
parser.add_argument('--borders-only',action='store_true',
 help='Extract only the 5 rarity borders. Skips portraits, plates, banner text and the font/portrait-atlas inputs.')
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
wanted=[entry for entry in asset_map['sources']
 if not args.borders_only or entry['file'].endswith('.png')]
for entry in wanted:
 path=assets/entry['file']
 if hashlib.sha256(path.read_bytes()).hexdigest()!=entry['sha256']:
  raise ValueError('Client UI asset hash mismatch: '+entry['file'])
atlas4=Image.open(ui/'cardstorageseason2_i4e.png').convert('RGBA')
atlas2=Image.open(ui/'cardstorageseason2_i2.png').convert('RGBA')
# Atlas rectangles are x/y/width/height, ordered by application rarity
# (normal, uncommon, rare, epic, legendary). They were calibrated against real
# screenshots; detect_border_interiors() below re-derives each frame's empty
# interior from the atlas pixels and fails if a box no longer matches, so a
# wrong rectangle cannot pass silently.
border_boxes=[(819,261,165,250),(518,553,166,250),(644,3,166,250),(643,261,166,250),(819,3,166,250)]
def detect_border_interiors(atlas,min_width=150,min_height=220):
 """Find frame interiors: transparent regions fully enclosed by solid pixels.

 The outer glow is excluded on purpose. The game draws the frame core; the
 soft glow around it is larger than the card and made crop boxes match real
 screenshots worse when included (measured, see docs/card-image-structure.md).
 """
 import numpy as np
 from collections import deque
 alpha=np.asarray(atlas.split()[3])
 opaque=alpha>=200
 H,W=opaque.shape
 outside=np.zeros((H,W),dtype=bool);queue=deque()
 for x in range(W):
  for y in (0,H-1):
   if not opaque[y,x] and not outside[y,x]:outside[y,x]=True;queue.append((y,x))
 for y in range(H):
  for x in (0,W-1):
   if not opaque[y,x] and not outside[y,x]:outside[y,x]=True;queue.append((y,x))
 while queue:
  cy,cx=queue.popleft()
  for dy,dx in ((1,0),(-1,0),(0,1),(0,-1)):
   ny,nx=cy+dy,cx+dx
   if 0<=ny<H and 0<=nx<W and not opaque[ny,nx] and not outside[ny,nx]:
    outside[ny,nx]=True;queue.append((ny,nx))
 holes=~opaque&~outside
 seen=np.zeros((H,W),dtype=bool);found=[]
 for y in range(H):
  for x in range(W):
   if not holes[y,x] or seen[y,x]:continue
   comp=[(y,x)];seen[y,x]=True;minx=maxx=x;miny=maxy=y;at=0
   while at<len(comp):
    cy,cx=comp[at];at+=1
    minx=min(minx,cx);maxx=max(maxx,cx);miny=min(miny,cy);maxy=max(maxy,cy)
    for dy,dx in ((1,0),(-1,0),(0,1),(0,-1)):
     ny,nx=cy+dy,cx+dx
     if 0<=ny<H and 0<=nx<W and holes[ny,nx] and not seen[ny,nx]:
      seen[ny,nx]=True;comp.append((ny,nx))
   w,h=maxx-minx+1,maxy-miny+1
   if w>=min_width and h>=min_height:found.append((minx,miny,w,h))
 return found
def verify_border_boxes(atlas,boxes):
 interiors=detect_border_interiors(atlas)
 used=set()
 for rarity,(x,y,w,h) in enumerate(boxes):
  match=None
  for index,(ix,iy,iw,ih) in enumerate(interiors):
   if index in used:continue
   if x<=ix and y<=iy and ix+iw<=x+w and iy+ih<=y+h:
    match=(index,ix,iy,iw,ih);break
  if match is None:
   raise ValueError(f'Border box for rarity {rarity} contains no frame interior: {(x,y,w,h)}')
  used.add(match[0])
  index,ix,iy,iw,ih=match
  edges=(ix-x, iy-y, (x+w)-(ix+iw), (y+h)-(iy+ih))
  if any(edge<0 or edge>14 for edge in edges):
   raise ValueError(f'Border box for rarity {rarity} has implausible frame thickness {edges}')
  print(f'border rarity {rarity}: box={(x,y,w,h)} interior={(ix,iy,iw,ih)} thickness L/T/R/B={edges}')
 if len(interiors)!=len(boxes):
  print(f'note: atlas has {len(interiors)} frame interiors, expected {len(boxes)}')
def crop(im,box):
 x,y,w,h=box
 if x<0 or y<0 or w<=0 or h<=0 or x+w>im.width or y+h>im.height:
  raise ValueError('Invalid atlas rectangle: '+str(box))
 return im.crop((x,y,x+w,y+h))
verify_border_boxes(atlas4,border_boxes)
borders=[crop(atlas4,b).resize((140,210),Image.Resampling.LANCZOS) for b in border_boxes]
if args.borders_only:
 out_borders=out/'borders';out_borders.mkdir(parents=True,exist_ok=True)
 out_native=out/'borders-native';out_native.mkdir(parents=True,exist_ok=True)
 native=[]
 for rarity,box in enumerate(border_boxes):
  # Exact client pixels: no resampling. Callers scale to their own UI scale.
  exact=crop(atlas4,box)
  exact.save(out_native/f'border-{rarity}.png')
  borders[rarity].save(out_borders/f'border-{rarity}.png')
  x,y,w,h=box
  alpha=exact.getchannel('A')
  native.append({'rarity':rarity,'box':[x,y,w,h],
   'tightBbox':list(alpha.getbbox()) if alpha.getbbox() else None,
   'sha256':hashlib.sha256((out_native/f'border-{rarity}.png').read_bytes()).hexdigest()})
 (out/'borders-provenance.json').write_text(json.dumps({'canvas':[140,210],'borderBoxes':border_boxes,
  'native':native,
  'files':['border-0.png','border-1.png','border-2.png','border-3.png','border-4.png'],
  'nativeFiles':[f'borders-native/border-{i}.png' for i in range(5)],
  'hashes':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in [ui/'cardstorageseason2_i2.png',ui/'cardstorageseason2_i4e.png']},
  'placementSource':'atlas rectangles from build-composed-card-templates.py; borders-native preserves client pixels, borders/ is resampled to the scanner canvas'},
  indent=2)+'\n')
 print(json.dumps({'borders':len(borders),'native':len(native)},ensure_ascii=False))
 sys.exit(0)
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
