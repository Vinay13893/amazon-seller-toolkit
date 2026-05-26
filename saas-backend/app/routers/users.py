import uuid
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.orm import Session
from ..database import get_db
from ..models import User, SellerCredential
from ..schemas import UserSignup, UserLogin, TokenResponse, UserOut, CredentialConnect, CredentialStatus
from ..auth import hash_password, verify_password, create_access_token, get_current_user
from ..credentials import encrypt_token

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/signup", response_model=UserOut, status_code=status.HTTP_201_CREATED)
def signup(payload: UserSignup, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == payload.email).first():
        raise HTTPException(status_code=400, detail="Email already registered")

    user = User(
        id=uuid.uuid4(),
        email=payload.email,
        password_hash=hash_password(payload.password),
        full_name=payload.full_name,
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@router.post("/login", response_model=TokenResponse)
def login(payload: UserLogin, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == payload.email).first()
    if not user or not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid credentials")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account disabled")
    return {"access_token": create_access_token(str(user.id))}


@router.get("/me", response_model=UserOut)
def me(current_user: User = Depends(get_current_user)):
    return current_user


@router.post("/connect-amazon", response_model=CredentialStatus)
def connect_amazon(
    payload: CredentialConnect,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Store (or update) the user's Amazon API refresh tokens, encrypted at rest.
    Users get these tokens by authorising your developer app from their Seller Central.
    """
    cred = db.query(SellerCredential).filter(
        SellerCredential.user_id == current_user.id,
        SellerCredential.marketplace == payload.marketplace,
    ).first()

    if not cred:
        cred = SellerCredential(id=uuid.uuid4(), user_id=current_user.id, marketplace=payload.marketplace)
        db.add(cred)

    if payload.sp_refresh_token:
        cred.sp_refresh_token_enc = encrypt_token(payload.sp_refresh_token)
    if payload.seller_id:
        cred.seller_id = payload.seller_id
    if payload.ads_refresh_token:
        cred.ads_refresh_token_enc = encrypt_token(payload.ads_refresh_token)
    if payload.ads_profile_id:
        cred.ads_profile_id = payload.ads_profile_id

    db.commit()
    db.refresh(cred)

    return CredentialStatus(
        marketplace=cred.marketplace,
        sp_connected=cred.sp_refresh_token_enc is not None,
        ads_connected=cred.ads_refresh_token_enc is not None,
        seller_id=cred.seller_id,
        ads_profile_id=cred.ads_profile_id,
        last_sync_at=cred.last_sync_at,
    )


@router.get("/amazon-status", response_model=list[CredentialStatus])
def amazon_status(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Check which Amazon accounts the user has connected."""
    creds = db.query(SellerCredential).filter(SellerCredential.user_id == current_user.id).all()
    return [
        CredentialStatus(
            marketplace=c.marketplace,
            sp_connected=c.sp_refresh_token_enc is not None,
            ads_connected=c.ads_refresh_token_enc is not None,
            seller_id=c.seller_id,
            ads_profile_id=c.ads_profile_id,
            last_sync_at=c.last_sync_at,
        )
        for c in creds
    ]
